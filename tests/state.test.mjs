import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import vm from 'node:vm';
import {defaults,normalizeState,stableState,parseFrozen,envelope,sha256} from '../web/state.js';
import {sha256Fallback} from '../web/hash.js';
let cases=0;
for(const n of [0,1,3,55,56,63,64,65,127,128,1024,1024*1024]){const b=randomBytes(n),expected=createHash('sha256').update(b).digest('hex');assert.equal(sha256Fallback(b),expected);assert.equal(await sha256(b),expected);cases++;}
const abc=new TextEncoder().encode('abc');assert.equal(sha256Fallback(abc),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');cases++;
const state=defaults();assert.deepEqual(normalizeState(state),state);cases++;
const zero={...state,morphs:{weight:0},pose:{head:[0,0,0]},expressions:{smile:0}};assert.equal(stableState(zero),stableState(state));cases++;
assert.equal(normalizeState(vm.runInNewContext('('+JSON.stringify(state)+')')).schema,state.schema);cases++;
for(const bad of [null,[],{}, {...state,schema:'old'}, {...state,sex:2},{...state,sex:'1'},{...state,morphs:[]},{...state,morphs:{weight:NaN}},{...state,pose:{head:[0,0]}},JSON.parse(JSON.stringify(state).replace('"morphs":{}','"morphs":{"__proto__":{}}'))]){assert.throws(()=>normalizeState(bad));cases++;}
let deep={};for(let i=0;i<20;i++)deep={deep};assert.throws(()=>normalizeState({...state,deep}));cases++;
assert.throws(()=>normalizeState({...state,description:'x'.repeat(131073)}));cases++;
const frozen=envelope(state,'a'.repeat(64));assert.deepEqual(parseFrozen(JSON.stringify(frozen)),frozen);assert.equal(parseFrozen('{}'),null);assert.throws(()=>envelope(state,'wrong'));cases+=3;
console.log(JSON.stringify({passed:true,cases,sha256Vectors:13,crossRealmState:true},null,2));
