import type {MarketFixture} from './market-helpers.ts';
export const PRINT_ITEM='PRINT-PART-SYNTH',PRINT_MATERIAL='PRINT-PETG-SPOOL-SYNTH';
// Explicit opt-in fixture only. Never called by boot, migrations, production
// seeds, app routes or a serving runtime. Refuse any non-generated database.
export async function addPrintFixture(f:MarketFixture) {
  const url=new URL(f.connectionString);
  if (!['127.0.0.1','localhost'].includes(url.hostname) || !/^\/vv_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Print fixture requires the disposable test database.');
  const actual=(await f.pool.query('SELECT current_database() AS name')).rows[0]?.name;
  if (actual!==url.pathname.slice(1)) throw new Error('Print fixture pool does not match the disposable test database.');
  await f.pool.query(`INSERT INTO market_items(id,specification_revision,name,description,specification_label,unit,specification) VALUES
    ($1,1,'Synthetic printed test part','Fabricated 20 mm cube, not a user design or engineering assertion.','print-synth-r1','each',$2),
    ($3,1,'Synthetic PETG spool','Fictional counted spool. No grams, consumption, conversion or yield authority.','petg-synth-r1','each',$4)`,
  [PRINT_ITEM,{synthetic:true,shape:'20 mm test cube',profile:'mock FDM / PETG / 1.75 mm',fileUploaded:false},PRINT_MATERIAL,{synthetic:true,profile:'mock PETG / 1.75 mm',unit:'counted spool'}]);
}
