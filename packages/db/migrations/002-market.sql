-- Additive market profile for a NEW isolated database only. Runtime bootstrap does
-- not upgrade an existing foundation schema or enroll its historic grants.
CREATE TABLE market_schema(version text PRIMARY KEY CHECK(version='market.v0.1'));
INSERT INTO market_schema VALUES('market.v0.1');
ALTER TABLE grants ADD COLUMN market_scopes text[] NOT NULL DEFAULT ARRAY[]::text[];
CREATE TABLE market_items (
  id text NOT NULL, specification_revision integer NOT NULL CHECK(specification_revision>0),
  name text NOT NULL, description text NOT NULL, specification_label text NOT NULL,
  unit text NOT NULL CHECK(unit='each'), specification jsonb NOT NULL,
  synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), PRIMARY KEY(id,specification_revision)
);
CREATE TABLE market_orders (
  id text PRIMARY KEY, item_id text NOT NULL, specification_revision integer NOT NULL,
  organization_id text NOT NULL, actor_id text NOT NULL REFERENCES memberships(actor_id),
  side text NOT NULL CHECK(side IN ('buy','sell')), supply_mode text CHECK(supply_mode IN ('stock','made_to_order')),
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991), unit text NOT NULL CHECK(unit='each'),
  allocated_quantity bigint NOT NULL DEFAULT 0 CHECK(allocated_quantity BETWEEN 0 AND quantity),
  unit_price bigint NOT NULL CHECK(unit_price BETWEEN 0 AND 9007199254740991), currency text NOT NULL CHECK(currency='USD'),
  location text NOT NULL, available_at timestamptz NOT NULL, delivery_by timestamptz NOT NULL,
  terms text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  record_version integer NOT NULL DEFAULT 1 CHECK(record_version>0),
  state text NOT NULL DEFAULT 'published' CHECK(state IN ('published','allocated')),
  synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(item_id,specification_revision) REFERENCES market_items(id,specification_revision),
  CHECK(delivery_by>=available_at), CHECK((side='buy' AND supply_mode IS NULL) OR (side='sell' AND supply_mode IS NOT NULL)),
  CHECK((allocated_quantity=quantity)=(state='allocated'))
);
CREATE TABLE market_proposals (
  id text PRIMARY KEY, buy_order_id text NOT NULL REFERENCES market_orders(id), sell_order_id text NOT NULL REFERENCES market_orders(id),
  buyer_organization text NOT NULL, seller_organization text NOT NULL,
  actor_id text NOT NULL REFERENCES memberships(actor_id), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  record_version integer NOT NULL DEFAULT 1 CHECK(record_version>0),
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991), unit text NOT NULL CHECK(unit='each'),
  unit_price bigint NOT NULL CHECK(unit_price BETWEEN 0 AND 9007199254740991), currency text NOT NULL CHECK(currency='USD'),
  expires_at timestamptz NOT NULL, buy_snapshot jsonb NOT NULL, sell_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','partially_approved','committed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(buy_order_id<>sell_order_id), CHECK(buyer_organization<>seller_organization)
);
CREATE TABLE market_approvals (
  proposal_id text NOT NULL REFERENCES market_proposals(id), side text NOT NULL CHECK(side IN ('buy','sell')),
  proposal_revision integer NOT NULL CHECK(proposal_revision>0), actor_id text NOT NULL REFERENCES memberships(actor_id),
  organization_id text NOT NULL, grant_id text NOT NULL REFERENCES grants(id), approved_at timestamptz NOT NULL,
  PRIMARY KEY(proposal_id,side)
);
CREATE TABLE market_commitments (
  id text PRIMARY KEY, proposal_id text NOT NULL UNIQUE REFERENCES market_proposals(id),
  buy_order_id text NOT NULL REFERENCES market_orders(id), sell_order_id text NOT NULL REFERENCES market_orders(id),
  buyer_organization text NOT NULL, seller_organization text NOT NULL,
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991), unit text NOT NULL CHECK(unit='each'),
  reported_quantity bigint NOT NULL DEFAULT 0 CHECK(reported_quantity BETWEEN 0 AND quantity),
  acknowledged_quantity bigint NOT NULL DEFAULT 0 CHECK(acknowledged_quantity BETWEEN 0 AND reported_quantity),
  record_version integer NOT NULL DEFAULT 1 CHECK(record_version>0),
  state text NOT NULL DEFAULT 'committed' CHECK(state IN ('committed','in_progress','completed')),
  committed_at timestamptz NOT NULL, CHECK((acknowledged_quantity=quantity)=(state='completed'))
);
CREATE TABLE market_fulfillments (
  id text PRIMARY KEY, commitment_id text NOT NULL REFERENCES market_commitments(id),
  actor_id text NOT NULL REFERENCES memberships(actor_id), quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
  unit text NOT NULL CHECK(unit='each'), note text, reported_at timestamptz NOT NULL,
  acknowledged boolean NOT NULL DEFAULT false, acknowledged_by text REFERENCES memberships(actor_id), acknowledged_at timestamptz,
  record_version integer NOT NULL DEFAULT 1 CHECK(record_version>0),
  CHECK(acknowledged=(acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL))
);
CREATE TABLE market_projects (
  id text PRIMARY KEY, name text NOT NULL, description text NOT NULL,
  whole_house_order_id text NOT NULL REFERENCES market_orders(id), synthetic boolean NOT NULL DEFAULT true CHECK(synthetic)
);
CREATE TABLE market_project_orders (
  project_id text NOT NULL REFERENCES market_projects(id), order_id text NOT NULL REFERENCES market_orders(id),
  PRIMARY KEY(project_id,order_id)
);
CREATE TABLE market_audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE, id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES memberships(actor_id), organization_id text NOT NULL, operation text NOT NULL,
  order_ids text[] NOT NULL, participant_organizations text[] NOT NULL, private boolean NOT NULL,
  payload jsonb NOT NULL, happened_at timestamptz NOT NULL
);
CREATE TABLE market_outbox (
  event_id text PRIMARY KEY REFERENCES market_audit_events(id), state text NOT NULL DEFAULT 'pending' CHECK(state='pending')
);
CREATE TABLE market_idempotency (
  actor_id text NOT NULL, organization_id text NOT NULL, operation text NOT NULL, key text NOT NULL,
  fingerprint text NOT NULL, order_ids text[] NOT NULL, private boolean NOT NULL,
  participant_organizations text[] NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(actor_id,organization_id,operation,key)
);
CREATE INDEX market_orders_browse ON market_orders(item_id,id);
CREATE INDEX market_orders_own ON market_orders(organization_id,id);
CREATE INDEX market_proposals_participants ON market_proposals(buyer_organization,seller_organization,id);
CREATE INDEX market_commitments_participants ON market_commitments(buyer_organization,seller_organization,id);
CREATE INDEX market_audit_order ON market_audit_events USING gin(order_ids);
CREATE TRIGGER market_items_immutable BEFORE UPDATE OR DELETE ON market_items FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER market_approvals_immutable BEFORE UPDATE OR DELETE ON market_approvals FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER market_projects_immutable BEFORE UPDATE OR DELETE ON market_projects FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER market_links_immutable BEFORE UPDATE OR DELETE ON market_project_orders FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER market_audit_immutable BEFORE UPDATE OR DELETE ON market_audit_events FOR EACH ROW EXECUTE FUNCTION deny_audit_change();
CREATE TRIGGER market_results_immutable BEFORE UPDATE OR DELETE ON market_idempotency FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE FUNCTION protect_market_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['allocated_quantity','record_version','state']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['allocated_quantity','record_version','state'])
    OR NEW.allocated_quantity<=OLD.allocated_quantity OR NEW.record_version<>OLD.record_version+1
  THEN RAISE EXCEPTION 'immutable market order terms or released allocation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_order_transition BEFORE UPDATE ON market_orders FOR EACH ROW EXECUTE FUNCTION protect_market_order();
CREATE FUNCTION protect_market_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['record_version','state']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['record_version','state'])
    OR OLD.state='committed' OR NEW.record_version<>OLD.record_version+1
    OR (OLD.state='proposed' AND NEW.state<>'partially_approved')
    OR (OLD.state='partially_approved' AND NEW.state<>'committed')
  THEN RAISE EXCEPTION 'immutable market proposal consent'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_proposal_transition BEFORE UPDATE ON market_proposals FOR EACH ROW EXECUTE FUNCTION protect_market_proposal();
CREATE FUNCTION protect_market_commitment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['reported_quantity','acknowledged_quantity','record_version','state']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['reported_quantity','acknowledged_quantity','record_version','state'])
    OR NEW.reported_quantity<OLD.reported_quantity OR NEW.acknowledged_quantity<OLD.acknowledged_quantity
    OR NEW.record_version<>OLD.record_version+1 OR OLD.state='completed'
  THEN RAISE EXCEPTION 'protected market commitment'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_commitment_transition BEFORE UPDATE ON market_commitments FOR EACH ROW EXECUTE FUNCTION protect_market_commitment();
CREATE FUNCTION protect_market_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['acknowledged','acknowledged_by','acknowledged_at','record_version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['acknowledged','acknowledged_by','acknowledged_at','record_version'])
    OR OLD.acknowledged OR NOT NEW.acknowledged OR NEW.record_version<>OLD.record_version+1
  THEN RAISE EXCEPTION 'protected market fulfillment acknowledgement'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_fulfillment_transition BEFORE UPDATE ON market_fulfillments FOR EACH ROW EXECUTE FUNCTION protect_market_fulfillment();
CREATE TRIGGER market_orders_no_delete BEFORE DELETE ON market_orders FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER market_proposals_no_delete BEFORE DELETE ON market_proposals FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER market_commitments_no_delete BEFORE DELETE ON market_commitments FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER market_fulfillments_no_delete BEFORE DELETE ON market_fulfillments FOR EACH ROW EXECUTE FUNCTION deny_record_change();
