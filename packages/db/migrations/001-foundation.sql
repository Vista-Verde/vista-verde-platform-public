CREATE TABLE foundation_schema(version text PRIMARY KEY CHECK(version = 'foundation.v0.1'));
INSERT INTO foundation_schema VALUES ('foundation.v0.1');
CREATE TABLE accounts (
  id text PRIMARY KEY, organization_id text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  balance bigint NOT NULL CHECK(balance BETWEEN 0 AND 9007199254740991),
  reserved bigint NOT NULL DEFAULT 0 CHECK(reserved BETWEEN 0 AND balance),
  synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), UNIQUE(id, currency)
);
CREATE TABLE memberships (
  actor_id text PRIMARY KEY, organization_id text NOT NULL, account_id text REFERENCES accounts(id),
  role text NOT NULL CHECK(role IN ('buyer_agent','buyer_human','producer','operator')),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE grants (
  id text PRIMARY KEY, actor_id text NOT NULL REFERENCES memberships(actor_id),
  token_hash text NOT NULL UNIQUE, operations text[] NOT NULL, requirement_scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
  max_per_command bigint NOT NULL CHECK(max_per_command BETWEEN 0 AND 9007199254740991),
  budget_limit bigint NOT NULL CHECK(budget_limit BETWEEN 0 AND 9007199254740991),
  used_minor bigint NOT NULL DEFAULT 0 CHECK(used_minor BETWEEN 0 AND budget_limit)
);
CREATE TABLE specifications (
  id text NOT NULL, revision integer NOT NULL CHECK(revision > 0), unit text NOT NULL,
  criteria jsonb NOT NULL, reviewed_fixture boolean NOT NULL CHECK(reviewed_fixture), PRIMARY KEY(id,revision)
);
CREATE TABLE fixture_terms (
  id text NOT NULL, revision integer NOT NULL CHECK(revision > 0), recipient_account text NOT NULL REFERENCES accounts(id),
  compensation_trigger text NOT NULL CHECK(compensation_trigger='accepted_full_slot'),
  disposition text NOT NULL CHECK(disposition='unpurchased_release_only'), synthetic boolean NOT NULL CHECK(synthetic),
  PRIMARY KEY(id,revision)
);
CREATE TABLE capabilities (
  organization_id text PRIMARY KEY, processes text[] NOT NULL, evidence_status text NOT NULL,
  confirmed_at timestamptz NOT NULL
);
CREATE TABLE requirements (
  id text PRIMARY KEY, buyer_organization text NOT NULL, buyer_account text NOT NULL REFERENCES accounts(id),
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0), record_version integer NOT NULL DEFAULT 1 CHECK(record_version > 0),
  state text NOT NULL CHECK(state IN ('draft','published')), draft jsonb NOT NULL,
  UNIQUE(id, revision)
);
CREATE TABLE requirement_lines (
  requirement_id text NOT NULL REFERENCES requirements(id), line_id text NOT NULL,
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991), unit text NOT NULL,
  specification_id text NOT NULL, specification_revision integer NOT NULL CHECK(specification_revision > 0),
  PRIMARY KEY(requirement_id,line_id)
);
CREATE TABLE slots (
  id text PRIMARY KEY, requirement_id text NOT NULL, line_id text NOT NULL,
  requirement_revision integer NOT NULL, specification_id text NOT NULL, specification_revision integer NOT NULL,
  terms_id text NOT NULL, terms_revision integer NOT NULL,
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991), unit text NOT NULL,
  compensation bigint NOT NULL CHECK(compensation BETWEEN 0 AND 9007199254740991),
  price bigint NOT NULL CHECK(price BETWEEN 0 AND 9007199254740991), currency text NOT NULL,
  expires_at timestamptz NOT NULL, record_version integer NOT NULL DEFAULT 1 CHECK(record_version > 0),
  state text NOT NULL CHECK(state IN ('available','purchased','withdrawn','expired')),
  FOREIGN KEY(requirement_id,line_id) REFERENCES requirement_lines(requirement_id,line_id),
  FOREIGN KEY(requirement_id,requirement_revision) REFERENCES requirements(id,revision),
  FOREIGN KEY(specification_id,specification_revision) REFERENCES specifications(id,revision),
  FOREIGN KEY(terms_id,terms_revision) REFERENCES fixture_terms(id,revision), UNIQUE(id,currency)
);
CREATE TABLE commitments (
  id text PRIMARY KEY, slot_id text NOT NULL UNIQUE REFERENCES slots(id),
  producer_organization text NOT NULL, actor_id text NOT NULL REFERENCES memberships(actor_id),
  receipt jsonb NOT NULL, state text NOT NULL CHECK(state='purchased'), UNIQUE(id,slot_id)
);
CREATE TABLE holds (
  slot_id text PRIMARY KEY, buyer_account text NOT NULL, currency text NOT NULL,
  amount bigint NOT NULL CHECK(amount BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK(state IN ('held','committed','released')), commitment_id text UNIQUE,
  FOREIGN KEY(slot_id,currency) REFERENCES slots(id,currency),
  FOREIGN KEY(buyer_account,currency) REFERENCES accounts(id,currency),
  FOREIGN KEY(commitment_id,slot_id) REFERENCES commitments(id,slot_id),
  CHECK((state='committed' AND commitment_id IS NOT NULL) OR (state IN ('held','released') AND commitment_id IS NULL))
);
CREATE TABLE journal_entries (
  commitment_id text NOT NULL REFERENCES commitments(id), account_id text NOT NULL, currency text NOT NULL,
  amount bigint NOT NULL CHECK(amount BETWEEN -9007199254740991 AND 9007199254740991),
  kind text NOT NULL CHECK(kind='synthetic_slot_price'),
  FOREIGN KEY(account_id,currency) REFERENCES accounts(id,currency), PRIMARY KEY(commitment_id,account_id)
);
CREATE TABLE audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id text PRIMARY KEY, requirement_id text NOT NULL REFERENCES requirements(id),
  actor_id text NOT NULL REFERENCES memberships(actor_id), payload jsonb NOT NULL, happened_at timestamptz NOT NULL
);
CREATE FUNCTION deny_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only audit'; END $$;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_audit_change();
CREATE TABLE outbox (
  event_id text PRIMARY KEY REFERENCES audit_events(id), state text NOT NULL DEFAULT 'pending' CHECK(state='pending')
);
CREATE TABLE idempotency (
  actor_id text NOT NULL, organization_id text NOT NULL, operation text NOT NULL, key text NOT NULL,
  fingerprint text NOT NULL, requirement_id text NOT NULL REFERENCES requirements(id), cost bigint NOT NULL,
  result jsonb NOT NULL, PRIMARY KEY(actor_id,organization_id,operation,key)
);
CREATE TABLE fixture_aliases(source text NOT NULL, legacy_id text NOT NULL, current_id text NOT NULL, PRIMARY KEY(source,legacy_id));

-- Lock-ID discovery relies on these references being immutable. New released
-- specifications/terms are appended at a new revision; this slice exposes no edit path.
CREATE FUNCTION deny_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable foundation record'; END $$;
CREATE TRIGGER specifications_immutable BEFORE UPDATE OR DELETE ON specifications FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER terms_immutable BEFORE UPDATE OR DELETE ON fixture_terms FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER lines_immutable BEFORE UPDATE OR DELETE ON requirement_lines FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER commitments_immutable BEFORE UPDATE OR DELETE ON commitments FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE TRIGGER results_immutable BEFORE UPDATE OR DELETE ON idempotency FOR EACH ROW EXECUTE FUNCTION deny_record_change();
CREATE FUNCTION protect_requirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','record_version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','record_version'])
     OR OLD.state<>'draft' OR NEW.state<>'published' OR NEW.record_version<>OLD.record_version+1
  THEN RAISE EXCEPTION 'immutable requirement revision'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requirement_transition BEFORE UPDATE ON requirements FOR EACH ROW EXECUTE FUNCTION protect_requirement();
CREATE FUNCTION protect_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','record_version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','record_version'])
     OR OLD.state<>'available' OR NEW.state NOT IN ('purchased','withdrawn','expired') OR NEW.record_version<>OLD.record_version+1
  THEN RAISE EXCEPTION 'immutable slot allocation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER slot_transition BEFORE UPDATE ON slots FOR EACH ROW EXECUTE FUNCTION protect_slot();
CREATE FUNCTION protect_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','commitment_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','commitment_id'])
     OR OLD.state<>'held' OR NEW.state NOT IN ('committed','released')
  THEN RAISE EXCEPTION 'protected funding hold'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hold_transition BEFORE UPDATE ON holds FOR EACH ROW EXECUTE FUNCTION protect_hold();
