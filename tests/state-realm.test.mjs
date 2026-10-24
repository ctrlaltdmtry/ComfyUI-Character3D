// Regression: normalized state must not retain any foreign realm array prototype.
// Synthetic valid state fixture; real shared normalizeState, not a mock API.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {defaults,normalizeState,stableState} from '../web/state.js';
const fixture={...defaults(),pose:{head:[.1,.2,.3]},faceOffsets:{'lip.L':[.01,.02,.03]},camera:{position:[1,2,3],target:[0,1,0],zoom:1},extraVectorLists:[[1,2,3],[4,5,6]]};
const foreign=vm.runInNewContext('('+JSON.stringify(fixture)+')');
const normalized=normalizeState(foreign),arrays=[];
function inspect(v,path){if(Array.isArray(v)){arrays.push({path,parentPrototype:Object.getPrototypeOf(v)===Array.prototype});v.forEach((x,i)=>inspect(x,path+'['+i+']'));}else if(v&&typeof v==='object'){for(const [k,x]of Object.entries(v))inspect(x,path?path+'.'+k:k);}}
inspect(normalized,'');
const report={schema:'character3d-state-realm/1',scope:'Synthetic vm realm fixture; actual production normalizeState.',arrays,valuesPreserved:JSON.stringify(normalized)===JSON.stringify(normalizeState(fixture)),stableStatePreserved:stableState(foreign)===stableState(fixture),passed:arrays.every(a=>a.parentPrototype)};
fs.mkdirSync('tests/performance',{recursive:true});fs.writeFileSync('tests/performance/state-realm-'+(process.argv[2]||'current')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
assert.ok(report.valuesPreserved&&report.stableStatePreserved,'State values changed');assert.ok(report.passed,'normalizeState retained foreign Array.prototype; detached iframe realm can remain reachable through node/workflow state');
