import assert from 'node:assert/strict';
import {blendMorph,validateDelta,morphRange,clampMorph,connectIdentity} from '../identity-morphs.js';
// Synthetic unit-test fixtures only. Actual editor data is never synthesized.
let checks=0;const test=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
const d=[1,2,3,4,5,6],male=[2,3,4,5,6,7];
test('legacy dense arithmetic identical',()=>{for(const sex of [0,.4,1])for(const w of [-1,0,.5,1.5]){const a=new Float32Array([1,2,3,4,5,6]),b=a.slice();for(let i=0;i<a.length;i++)a[i]+=(d[i]+(male[i]-d[i])*sex)*w;blendMorph(b,{delta:d,maleDelta:male},w,sex);assert.deepEqual(b,a);}});
test('sparse positive',()=>{const out=new Float32Array(6);blendMorph(out,{delta:{indices:[1],values:[1,2,3]}},.5,0);assert.deepEqual([...out],[0,0,0,.5,1,1.5]);});
test('different sex sparse indices',()=>{const out=new Float32Array(6);blendMorph(out,{delta:{indices:[0],values:[2,0,0]},maleDelta:{indices:[1],values:[4,0,0]}},1,.25);assert.deepEqual([...out],[1.5,0,0,1,0,0]);});
test('negative uses actual authored target not inverse',()=>{const out=new Float32Array(6);blendMorph(out,{delta:{indices:[0],values:[9,0,0]},negativeDelta:{indices:[1],values:[-4,2,0]}},-.5,0);assert.deepEqual([...out],[0,0,0,-2,1,0]);});
test('paired male negative',()=>{const out=new Float32Array(3);blendMorph(out,{delta:[1,0,0],negativeDelta:[-2,0,0],negativeMaleDelta:[-4,0,0]},-.5,.5);assert.deepEqual([...out],[-1.5,0,0]);});
test('zero weight unchanged',()=>{const out=new Float32Array(d);blendMorph(out,{},0,.5);assert.deepEqual([...out],d);});
test('invalid dense lengths/finite',()=>{assert.throws(()=>validateDelta([0],3));assert.throws(()=>validateDelta([0,NaN,0],3));});
test('sparse sorted unique in range',()=>{for(const indices of [[1,0],[0,0],[-1],[1],[.5]])assert.throws(()=>validateDelta({indices,values:new Array(indices.length*3).fill(0)},3));});
test('sparse lengths/finite',()=>{assert.throws(()=>validateDelta({indices:[0],values:[1]},3));assert.throws(()=>validateDelta({indices:[0],values:[0,Infinity,0]},3));});
test('empty sparse allowed for unaffected attachments',()=>assert.doesNotThrow(()=>validateDelta({indices:[],values:[]},3)));
test('finite weights required',()=>{assert.throws(()=>blendMorph(new Float32Array(3),{delta:[1,0,0]},NaN,0));assert.throws(()=>blendMorph(new Float32Array(3),{delta:[1,0,0]},1,Infinity));});
test('legacy ranges preserved',()=>{assert.deepEqual(morphRange({id:'weight'}),[0,1]);assert.deepEqual(morphRange({id:'weight'},true),[-1,1.5]);});
test('genuine paired ranges and free extrapolation',()=>{const m={id:'identity_test',min:-1,max:1};assert.deepEqual(morphRange(m),[-1,1]);assert.deepEqual(morphRange(m,true),[-1.5,1.5]);assert.equal(clampMorph(m,-2),-1);assert.equal(clampMorph(m,-2,true),-1.5);});
test('one-sided new target stays one-sided',()=>assert.deepEqual(morphRange({id:'identity_test',min:0,max:1},true),[0,1.5]));
function fixture(){const delta={indices:[0],values:[1,0,0]},empty={indices:[],values:[]};const part={id:'teeth',positions:[0,0,0],morphs:[]};return {identity:{schema:'character-3d-identity/1',morphs:[{id:'identity_test',min:-1,max:1,delta,negativeDelta:delta,eyes:{delta:empty,negativeDelta:empty},parts:{teeth:{delta:empty,negativeDelta:empty}},rig:{delta:[0,0,0],negativeDelta:[0,0,0]}}]},body:{positions:[0,0,0],morphs:[],eyes:{positions:[0,0,0],morphs:[]}},rig:{bones:[{}],morphs:[]},parts:[{source:part}]};}
test('attach all matching topology channels',()=>{const f=fixture();assert.equal(connectIdentity(f.identity,f.body,f.rig,f.parts),1);assert.equal(f.body.morphs.length,1);assert.equal(f.body.eyes.morphs.length,1);assert.equal(f.parts[0].source.morphs.length,1);assert.equal(f.rig.morphs.length,1);});
test('whole asset preflight atomic',()=>{const f=fixture();f.identity.morphs.push({...f.identity.morphs[0],id:'identity_invalid',delta:[1]});assert.throws(()=>connectIdentity(f.identity,f.body,f.rig,f.parts));assert.equal(f.body.morphs.length,0);});
test('duplicate IDs rejected',()=>{const f=fixture();f.identity.morphs.push(f.identity.morphs[0]);assert.throws(()=>connectIdentity(f.identity,f.body,f.rig,f.parts));});
test('missing attachment and pivots rejected',()=>{for(const key of ['eyes','parts','rig']){const f=fixture();delete f.identity.morphs[0][key];assert.throws(()=>connectIdentity(f.identity,f.body,f.rig,f.parts));}});
test('signed range requires genuine negative',()=>{const f=fixture();delete f.identity.morphs[0].negativeDelta;assert.throws(()=>connectIdentity(f.identity,f.body,f.rig,f.parts));});
console.log(JSON.stringify({checks,passed:true}));
