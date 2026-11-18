import { build } from 'esbuild';
const development = process.env.VV_REACT_MODE === 'development';
await build({ entryPoints:['apps/web/main.tsx'],bundle:true,outfile:'dist/apps/web/app.js',format:'esm',platform:'browser',
  target:['es2023'],jsx:'automatic',jsxDev:development,minify:!development,define:{ 'process.env.NODE_ENV':JSON.stringify(development ? 'development' : 'production') },
  legalComments:'inline',metafile:true }).then(result => {
  const bytes = result.metafile!.outputs['dist/apps/web/app.js']!.bytes;
  console.log(`React ${development ? 'development / StrictMode effects' : 'production'} bundle: ${bytes} bytes; existing app.js/style.css HTTP paths.`);
});

await build({entryPoints:['apps/web/producer-exchange/standalone.tsx'],bundle:true,outfile:'dist/apps/web/producer-exchange.js',format:'esm',platform:'browser',target:['es2023'],jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':JSON.stringify('production')}});
