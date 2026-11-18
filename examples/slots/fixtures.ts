import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const FIXTURE_NOW = 1791460000000;
export function seedSyntheticFixture(path: string, buyerBalance = 10_000) {
  const db = new DatabaseSync(path);
  try {
    db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    db.exec('BEGIN IMMEDIATE');
    const account = db.prepare('INSERT INTO accounts(id, currency, balance) VALUES (?, ?, ?)');
    account.run('buyer-funds', 'USD', buyerBalance);
    account.run('other-buyer-funds', 'USD', 10_000);
    account.run('producer-a-funds', 'USD', 1_000);
    account.run('producer-b-funds', 'USD', 1_000);
    account.run('slot-price-suspense', 'USD', 0);
    const principal = db.prepare('INSERT INTO principals(id, organization, role, account_id) VALUES (?, ?, ?, ?)');
    principal.run('buyer', 'buyer-org', 'buyer', 'buyer-funds');
    principal.run('other-buyer', 'other-buyer-org', 'buyer', 'other-buyer-funds');
    principal.run('producer-a', 'producer-a-org', 'producer', 'producer-a-funds');
    principal.run('producer-b', 'producer-b-org', 'producer', 'producer-b-funds');
    principal.run('ineligible-producer', 'producer-c-org', 'producer', 'producer-b-funds');
    const requirement = db.prepare('INSERT INTO requirements VALUES (?, ?, 1, 1, 2, ?, ?, ?)');
    requirement.run('housing', 'buyer-funds', 'component', 'housing', 'draft');
    requirement.run('robotics', 'buyer-funds', 'component', 'robotics', 'draft');
    const eligible = db.prepare('INSERT INTO eligible_producers VALUES (?, ?)');
    for (const req of ['housing', 'robotics']) {
      for (const producer of ['producer-a', 'producer-b']) eligible.run(req, producer);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

export function publication(requirementId = 'housing', compensation = 6_000, slotId = `${requirementId}-last`) {
  return { requirementId, expectedRevision: 1, slots: [{ id: slotId, quantity: 1,
    termsRevision: 1, compensation, price: 100, currency: 'USD', expiresAt: FIXTURE_NOW + 60_000 }] };
}
export function purchase(slotId = 'housing-last') {
  return { slotId, specRevision: 1, termsRevision: 1 };
}
