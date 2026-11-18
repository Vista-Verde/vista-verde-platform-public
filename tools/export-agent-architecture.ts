import {transform} from'esbuild';
import{createElement}from'react';
import type{ComponentType}from'react';
import{renderToStaticMarkup}from'react-dom/server';
import{readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync}from'node:fs';
import{resolve,join}from'node:path';
import{pathToFileURL}from'node:url';

// Compile the same JSX used by Storybook. Temporary output stays inside this
// checkout so bare React imports resolve to the same pinned server renderer.
mkdirSync('.local',{recursive:true});
const temporary=mkdtempSync(resolve('.local/agent-architecture-'));
try{
  const result=await transform(readFileSync('apps/architecture/components.tsx','utf8'),{loader:'tsx',format:'esm',jsx:'automatic',target:'es2023'});
  const file=join(temporary,'diagram.mjs');writeFileSync(file,result.code);
  const module=await import(pathToFileURL(file).href)as{AgentArchitectureSvg:ComponentType<{compact?:boolean}>};
  mkdirSync('docs/assets',{recursive:true});
  for(const compact of[false,true]){
    const path=`docs/assets/agent-architecture${compact?'-mobile':''}.svg`;
    writeFileSync(path,renderToStaticMarkup(createElement(module.AgentArchitectureSvg,{compact}))+'\n');
    console.log(path);
  }
}finally{rmSync(temporary,{recursive:true,force:true});}
