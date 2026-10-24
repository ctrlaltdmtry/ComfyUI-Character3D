import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

test('i18n singleton and every dictionary resolve inside the actual WEB_DIRECTORY mount',()=>{
 const origin='http://qa.invalid',mount='/extensions/ComfyUI-Character3D/',visited=new Set();
 function visit(local,served){
  if(visited.has(local.href))return;visited.add(local.href);
  const source=fs.readFileSync(fileURLToPath(local),'utf8');
  for(const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){
   const spec=match[1];if(!spec.startsWith('.'))continue;const next=new URL(spec,served);
   assert.ok(next.pathname.startsWith(mount),`Locale import escapes mount: ${next.pathname}`);
   visit(new URL(spec,local),next);
  }
 }
 visit(new URL('../web/i18n.js',import.meta.url),new URL(mount+'i18n.js',origin));
 assert.equal(visited.size,4,'core plus all three message registries');
});
