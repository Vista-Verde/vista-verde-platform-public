-- Demand-led refinement. The repository executes this only during initialization
-- of an EMPTY isolated schema; existing persisted databases remain untouched.
ALTER TABLE market_schema DROP CONSTRAINT market_schema_version_check;
UPDATE market_schema SET version='market.v0.2';
ALTER TABLE market_schema ADD CHECK(version='market.v0.2');
ALTER TABLE market_orders ADD COLUMN kind text NOT NULL DEFAULT 'material_listing' CHECK(kind IN ('work_order','material_listing','capacity_offer'));
ALTER TABLE market_orders ADD COLUMN need text;
ALTER TABLE market_orders ADD COLUMN budget bigint CHECK(budget BETWEEN 0 AND 9007199254740991);
ALTER TABLE market_orders ADD COLUMN budget_committed bigint NOT NULL DEFAULT 0 CHECK(budget_committed BETWEEN 0 AND 9007199254740991);
ALTER TABLE market_orders ADD COLUMN linked_work_order_id text REFERENCES market_orders(id);
ALTER TABLE market_orders ADD CHECK(budget IS NULL OR budget_committed<=budget);
ALTER TABLE market_orders ADD CHECK(
  (kind='work_order' AND side='buy' AND need IS NOT NULL AND budget IS NOT NULL AND linked_work_order_id IS NULL)
  OR (kind='material_listing' AND side='sell' AND need IS NULL AND budget IS NULL AND budget_committed=0 AND linked_work_order_id IS NULL)
  OR (kind='capacity_offer' AND side='sell' AND need IS NULL AND budget IS NULL AND budget_committed=0 AND linked_work_order_id IS NOT NULL)
);
CREATE TABLE market_material_links (
  id text PRIMARY KEY, work_order_id text NOT NULL REFERENCES market_orders(id), material_listing_id text NOT NULL REFERENCES market_orders(id),
  actor_id text NOT NULL REFERENCES memberships(actor_id), organization_id text NOT NULL,
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991), unit text NOT NULL CHECK(unit='each'),
  note text NOT NULL, created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), nonbinding boolean NOT NULL DEFAULT true CHECK(nonbinding),
  CHECK(work_order_id<>material_listing_id)
);
CREATE INDEX market_material_work ON market_material_links(work_order_id,id);
CREATE INDEX market_work_board ON market_orders(kind,id);
CREATE INDEX market_capacity_work ON market_orders(linked_work_order_id,id) WHERE kind='capacity_offer';
CREATE TRIGGER market_material_links_immutable BEFORE UPDATE OR DELETE ON market_material_links FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE OR REPLACE FUNCTION protect_market_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['allocated_quantity','budget_committed','record_version','state']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['allocated_quantity','budget_committed','record_version','state'])
    OR NEW.allocated_quantity<=OLD.allocated_quantity OR NEW.budget_committed<OLD.budget_committed OR NEW.record_version<>OLD.record_version+1
  THEN RAISE EXCEPTION 'immutable work terms or released allocation/budget'; END IF;
  RETURN NEW;
END $$;
