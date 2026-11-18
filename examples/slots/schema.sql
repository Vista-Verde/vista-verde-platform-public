-- Local synthetic spike only. PostgreSQL migrations remain future work.
PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  balance INTEGER NOT NULL CHECK(balance BETWEEN 0 AND 9007199254740991),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved BETWEEN 0 AND balance)
) STRICT;
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  organization TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('buyer', 'producer', 'operator')),
  account_id TEXT REFERENCES accounts(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
) STRICT;
CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  buyer_account TEXT NOT NULL REFERENCES accounts(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  spec_revision INTEGER NOT NULL CHECK(spec_revision > 0),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit TEXT NOT NULL,
  sector TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft', 'published'))
) STRICT;
CREATE TABLE eligible_producers (
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  PRIMARY KEY(requirement_id, principal_id)
) STRICT;
CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  spec_revision INTEGER NOT NULL CHECK(spec_revision > 0),
  terms_revision INTEGER NOT NULL CHECK(terms_revision > 0),
  compensation INTEGER NOT NULL CHECK(compensation BETWEEN 0 AND 9007199254740991),
  price INTEGER NOT NULL CHECK(price BETWEEN 0 AND 9007199254740991),
  currency TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('available', 'purchased', 'withdrawn', 'expired'))
) STRICT;
CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL UNIQUE REFERENCES slots(id),
  producer_id TEXT NOT NULL REFERENCES principals(id),
  spec_revision INTEGER NOT NULL,
  terms_revision INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  compensation INTEGER NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL
) STRICT;
CREATE TABLE reservations (
  slot_id TEXT PRIMARY KEY REFERENCES slots(id),
  buyer_account TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK(amount BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('held', 'committed', 'released')),
  commitment_id TEXT UNIQUE REFERENCES commitments(id),
  CHECK((state = 'committed' AND commitment_id IS NOT NULL) OR
        (state IN ('held', 'released') AND commitment_id IS NULL))
) STRICT;
CREATE TABLE journal_entries (
  commitment_id TEXT NOT NULL REFERENCES commitments(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind = 'synthetic_slot_price'),
  PRIMARY KEY(commitment_id, account_id)
) STRICT;
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES principals(id),
  organization TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  happened_at INTEGER NOT NULL,
  synthetic INTEGER NOT NULL CHECK(synthetic = 1)
) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'append-only audit'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'append-only audit'); END;
CREATE TABLE outbox (
  event_id TEXT PRIMARY KEY REFERENCES audit_events(id),
  state TEXT NOT NULL CHECK(state = 'pending')
) STRICT;
CREATE TABLE idempotency (
  actor_id TEXT NOT NULL REFERENCES principals(id),
  organization TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY(actor_id, organization, operation, key)
) STRICT;
