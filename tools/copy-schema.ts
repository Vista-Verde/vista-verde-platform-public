import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('dist/packages/db/migrations',{ recursive: true });
for (const file of ['001-foundation.sql','002-market.sql','003-work-orders.sql','004-sourcing.sql']) copyFileSync(`packages/db/migrations/${file}`,`dist/packages/db/migrations/${file}`);

mkdirSync('dist/apps/web',{ recursive: true });
copyFileSync('apps/web/index.html','dist/apps/web/index.html');
writeFileSync('dist/apps/web/style.css',[readFileSync('apps/web/style.css','utf8'),readFileSync('apps/web/market/market.css','utf8'),readFileSync('apps/print-demo/style.css','utf8'),readFileSync('apps/print-demo/routes.css','utf8'),readFileSync('apps/web/producer-exchange/style.css','utf8'),readFileSync('apps/web/market/compact.css','utf8')].join('\n'));
