-- Synthetic sourcing profile, initialized only with an EMPTY fixture schema.
-- These counters model declared fixture inventory, never certified physical stock.
ALTER TABLE market_schema DROP CONSTRAINT market_schema_version_check;
UPDATE market_schema SET version='market.v0.3';
ALTER TABLE market_schema ADD CHECK(version='market.v0.3');

CREATE TABLE market_inventory_lots (
  id text PRIMARY KEY, item_id text NOT NULL, specification_revision integer NOT NULL,
  organization_id text NOT NULL, quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
  unit text NOT NULL CHECK(unit='each'), used_quantity bigint NOT NULL DEFAULT 0 CHECK(used_quantity>=0),
  offered_quantity bigint NOT NULL DEFAULT 0 CHECK(offered_quantity>=0),
  allocated_quantity bigint NOT NULL DEFAULT 0 CHECK(allocated_quantity>=0),
  available_quantity bigint GENERATED ALWAYS AS (quantity-used_quantity-offered_quantity-allocated_quantity) STORED CHECK(available_quantity>=0),
  record_version integer NOT NULL DEFAULT 1 CHECK(record_version>0),
  source_fulfillment_id text UNIQUE REFERENCES market_fulfillments(id),
  source_lot_id text REFERENCES market_inventory_lots(id),
  source_commitment_id text REFERENCES market_commitments(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), synthetic boolean NOT NULL DEFAULT true CHECK(synthetic),
  FOREIGN KEY(item_id,specification_revision) REFERENCES market_items(id,specification_revision),
  CHECK((source_fulfillment_id IS NULL AND source_lot_id IS NULL AND source_commitment_id IS NULL)
    OR (source_fulfillment_id IS NOT NULL AND source_lot_id IS NOT NULL AND source_commitment_id IS NOT NULL)),
  CHECK(id IS DISTINCT FROM source_lot_id)
);
ALTER TABLE market_orders ADD COLUMN inventory_lot_id text REFERENCES market_inventory_lots(id);
ALTER TABLE market_orders ADD CHECK(inventory_lot_id IS NULL OR (kind='material_listing' AND side='sell' AND supply_mode='stock'));
CREATE INDEX market_inventory_owner ON market_inventory_lots(organization_id,id);
CREATE INDEX market_inventory_listing ON market_orders(inventory_lot_id,id) WHERE inventory_lot_id IS NOT NULL;

CREATE TABLE market_material_uses (
  id text PRIMARY KEY, lot_id text NOT NULL REFERENCES market_inventory_lots(id),
  actor_id text NOT NULL REFERENCES memberships(actor_id), organization_id text NOT NULL,
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991), unit text NOT NULL CHECK(unit='each'),
  note text NOT NULL, created_at timestamptz NOT NULL, synthetic boolean NOT NULL DEFAULT true CHECK(synthetic)
);
CREATE INDEX market_material_use_lot ON market_material_uses(lot_id,id);
CREATE TABLE market_stage_links (
  id text PRIMARY KEY, upstream_work_order_id text NOT NULL REFERENCES market_orders(id),
  downstream_work_order_id text NOT NULL REFERENCES market_orders(id),
  actor_id text NOT NULL REFERENCES memberships(actor_id), organization_id text NOT NULL,
  note text NOT NULL, created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), nonbinding boolean NOT NULL DEFAULT true CHECK(nonbinding),
  CHECK(upstream_work_order_id<>downstream_work_order_id), UNIQUE(upstream_work_order_id,downstream_work_order_id)
);
CREATE INDEX market_stage_downstream ON market_stage_links(downstream_work_order_id,id);
CREATE TRIGGER market_material_uses_immutable BEFORE UPDATE OR DELETE ON market_material_uses FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER market_stage_links_immutable BEFORE UPDATE OR DELETE ON market_stage_links FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE FUNCTION protect_market_inventory_lot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['used_quantity','offered_quantity','allocated_quantity','available_quantity','record_version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['used_quantity','offered_quantity','allocated_quantity','available_quantity','record_version'])
    OR NEW.used_quantity<OLD.used_quantity OR NEW.allocated_quantity<OLD.allocated_quantity
    OR NEW.used_quantity+NEW.offered_quantity+NEW.allocated_quantity < OLD.used_quantity+OLD.offered_quantity+OLD.allocated_quantity
    OR NEW.record_version<>OLD.record_version+1
  THEN RAISE EXCEPTION 'immutable inventory origin or released quantity'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_inventory_transition BEFORE UPDATE ON market_inventory_lots FOR EACH ROW EXECUTE FUNCTION protect_market_inventory_lot();
CREATE TRIGGER market_inventory_no_delete BEFORE DELETE ON market_inventory_lots FOR EACH ROW EXECUTE FUNCTION deny_record_change();
