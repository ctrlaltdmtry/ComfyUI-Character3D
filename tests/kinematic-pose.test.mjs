import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {matchLimbToIK, solveLimbPose} from '../kinematic-pose.js';

// Synthetic CPU fixtures using the actual vendored Three.js Bone/Object3D API.
// These are not measurements/biomechanical validation of production rig assets.
const near = (a,b,e=2e-9) => assert.ok(Math.abs(a-b) <= e, `${a} != ${b}`);
const vectorNear = (a,b,e) => a.forEach((v,i) => near(v,b[i],e));
const point = b => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray();
const distance = (a,b) => Math.hypot(...a.map((v,i) => v-b[i]));
function finiteJSON(v) {
  if (typeof v === 'number') assert.ok(Number.isFinite(v));
  if (v && typeof v === 'object') Object.values(v).forEach(finiteJSON);
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
}
function fixture({length1=2,length2=1.5, transformed=false, posed=false}={}) {
  const scene = new THREE.Scene(), parent = new THREE.Object3D(), upper = new THREE.Bone(), lower = new THREE.Bone(), end = new THREE.Bone();
  scene.add(parent); parent.add(upper); upper.add(lower); lower.add(end);
  upper.name = 'upper'; lower.name = 'lower'; end.name = 'end';
  lower.position.set(length1,0,0); end.position.set(length2,0,0);
  end.rotation.set(0.4,-0.7,0.2);
  if (transformed) {
    scene.position.set(-3,7,-2); scene.rotation.set(0.2,-0.3,0.7);
    parent.position.set(8,-4,3); parent.rotation.set(-0.8,0.5,0.4);
    upper.position.set(0.2,-0.3,0.5);
  }
  if (posed) { upper.rotation.set(0.8,-0.4,0.3); lower.rotation.set(-0.7,0.1,0.95); }
  scene.updateMatrixWorld(true);
  return {scene,parent,upper,lower,end};
}
const chain = f => ({upper:f.upper,lower:f.lower,end:f.end});
function snapshot(f) {
  const records=[];
  f.scene.traverse(n => records.push({uuid:n.uuid,parent:n.parent?.uuid || null,children:n.children.map(c=>c.uuid),
    position:n.position.toArray(),rotation:n.rotation.toArray(),quaternion:n.quaternion.toArray(),scale:n.scale.toArray(),
    matrix:n.matrix.toArray(),matrixWorld:n.matrixWorld.toArray(),matrixWorldNeedsUpdate:n.matrixWorldNeedsUpdate,
    matrixAutoUpdate:n.matrixAutoUpdate,matrixWorldAutoUpdate:n.matrixWorldAutoUpdate,userData:n.userData}));
  return JSON.stringify(records);
}
function applied(f,result) {
  const scene=f.scene.clone(true), byName={};
  scene.traverse(n=> {if (['upper','lower','end'].includes(n.name)) byName[n.name]=n;});
  // Three Object3D.clone() reconstructs Euler angles from quaternions, losing
  // raw full turns / a few ULPs. Restore end's original Euler on this test copy
  // before applying the adapter's ONLY upper/lower rotations.
  byName.end.rotation.copy(f.end.rotation);
  byName.upper.rotation.set(...result.rotations.upper,'XYZ');
  byName.lower.rotation.set(...result.rotations.lower,'XYZ');
  scene.updateMatrixWorld(true);
  return {...byName,scene};
}
function verify(f,input,result=solveLimbPose({...chain(f),...input})) {
  assert.equal(result.ok,true,JSON.stringify(result.error));
  finiteJSON(result);
  const actual=applied(f,result);
  vectorNear(point(actual.upper),result.root);
  vectorNear(point(actual.lower),result.elbow);
  vectorNear(point(actual.end),result.end);
  near(distance(result.root,result.elbow),result.diagnostics.length1);
  near(distance(result.elbow,result.end),result.diagnostics.length2);
  near(distance(result.end,input.target),result.diagnostics.targetError);
  assert.deepEqual(actual.end.rotation.toArray(),f.end.rotation.toArray());
  for (const v of Object.values(result.bendInfo)) near(Math.hypot(...v),1);
  if (result.diagnostics.endpointReached) vectorNear(result.end,input.target);
  return result;
}
function worldGoal(f, local) {
  return new THREE.Vector3(...local).applyMatrix4(f.parent.matrixWorld).toArray();
}
function matchedInput(f, extra={}) {
  const m=matchLimbToIK({...chain(f),...extra});
  assert.equal(m.ok,true,JSON.stringify(m.error)); finiteJSON(m);
  return {target:m.target,pole:m.pole,previousBend:m.bendInfo.bendDirection,previousDirection:m.bendInfo.direction};
}

test('synthetic FK match preserves exact local XYZ, upper twist and end rotation under transformed ancestors', () => {
  const f=fixture({transformed:true,posed:true});
  f.upper.rotation.x += 4*Math.PI; f.lower.rotation.z -= 2*Math.PI; f.scene.updateMatrixWorld(true);
  const before=snapshot(f), goal=matchedInput(f), result=verify(f,goal);
  assert.deepEqual(result.rotations.upper,[f.upper.rotation.x,f.upper.rotation.y,f.upper.rotation.z]);
  assert.deepEqual(result.rotations.lower,[f.lower.rotation.x,f.lower.rotation.y,f.lower.rotation.z]);
  assert.equal(result.diagnostics.noOp,true);
  vectorNear(goal.target,point(f.end));
  const actual=applied(f,result);
  near(Math.abs(new THREE.Quaternion().setFromRotationMatrix(actual.end.matrixWorld)
    .dot(new THREE.Quaternion().setFromRotationMatrix(f.end.matrixWorld))),1);
  assert.equal(snapshot(f),before);
});

test('actual rotated and translated ancestors yield correct reachable local XYZ rotations', () => {
  const f=fixture({transformed:true,posed:true}), origin=point(f.upper);
  const input={target:worldGoal(f,[2.1,0.3,1.1]),pole:worldGoal(f,[0.5,4,0.8])}, before=snapshot(f);
  const result=verify(f,input);
  assert.equal(result.diagnostics.reach,'reachable');
  assert.equal(result.diagnostics.angleClamped,false);
  vectorNear(result.end,input.target); vectorNear(result.root,origin);
  near(result.diagnostics.analyticEndpointError,0);
  assert.equal(snapshot(f),before);
});

test('minimal upper swing retains twist on a synthetic straight limb', () => {
  const f=fixture(); f.upper.rotation.x=1.2; f.scene.updateMatrixWorld(true);
  const input={target:[0,3.5,0],pole:[0,0,3]};
  const result=verify(f,input), actual=applied(f,result);
  const expected=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0))
    .multiply(f.upper.quaternion);
  near(Math.abs(actual.upper.quaternion.dot(expected)),1);
});

test('unequal lengths handle inner/outer unreachable targets without stretching', () => {
  for (const lengths of [[3,1],[1,3]]) for (const target of [[8,0,0],[0.1,0,0],[0,0,0]]) {
    const f=fixture({length1:lengths[0],length2:lengths[1],transformed:true,posed:true});
    const input={target:worldGoal(f,target),pole:worldGoal(f,[0,4,1])};
    const result=verify(f,input);
    assert.equal(result.diagnostics.unreachable,true);
    assert.equal(result.diagnostics.reachClamped,true);
    assert.equal(result.diagnostics.endpointReached,false);
    assert.ok(result.diagnostics.targetError>0);
    near(result.diagnostics.geometryTargetError,result.diagnostics.targetError);
  }
});

test('reachable unequal lengths may point the upper segment backwards', () => {
  const f=fixture({length1:1,length2:3});
  const result=verify(f,{target:[2.1,0,0],pole:[0,4,0]});
  assert.ok(result.elbow[0]<0); assert.equal(result.diagnostics.endpointReached,true);
});

test('morph-like refit uses current local positions and arbitrary rest directions, not cached lengths or +X assumptions', () => {
  const f=fixture({transformed:true,posed:true});
  f.lower.position.set(0.4,-1.9,0.7); f.end.position.set(-0.3,0.6,1.2); f.scene.updateMatrixWorld(true);
  const before=snapshot(f), noOp=verify(f,matchedInput(f));
  assert.equal(noOp.diagnostics.noOp,true);
  near(noOp.diagnostics.length1,f.lower.position.length()); near(noOp.diagnostics.length2,f.end.position.length());
  const input={target:worldGoal(f,[1.2,0.2,0.4]),pole:worldGoal(f,[-1,3,1])};
  verify(f,input); assert.equal(snapshot(f),before);
});

test('stable near-straight matching projects previous bend instead of tiny noisy elbow offsets', () => {
  const poles=[];
  for (const angle of [0,1e-12,-1e-12,1e-10,-1e-10]) {
    const f=fixture(); f.lower.rotation.z=angle; f.scene.updateMatrixWorld(true);
    const m=matchLimbToIK({...chain(f),previousBend:[0,0,-1],preferredBend:[0,1,0]});
    assert.equal(m.ok,true); assert.equal(m.diagnostics.bendSource,'previous');
    assert.equal(m.diagnostics.nearStraight,true); vectorNear(m.bendInfo.bendDirection,[0,0,-1]);
    near(distance(m.pole,m.root),3.5); poles.push(m.pole);
    const result=verify(f,{target:m.target,pole:m.pole,previousBend:m.bendInfo.bendDirection});
    assert.equal(result.diagnostics.noOp,true);
  }
  poles.forEach(p=>vectorNear(p,poles[0]));
});

test('straight match makes a nondegenerate local-axis pole even with unusable hints', () => {
  const f=fixture({transformed:true});
  const direction=new THREE.Vector3().subVectors(f.end.getWorldPosition(new THREE.Vector3()),f.upper.getWorldPosition(new THREE.Vector3())).normalize().toArray();
  const m=matchLimbToIK({...chain(f),previousBend:direction,preferredBend:[0,0,0]});
  assert.equal(m.ok,true); assert.equal(m.diagnostics.bendSource,'local-axis');
  near(m.bendInfo.bendDirection.reduce((sum,v,i)=>sum+v*direction[i],0),0);
  verify(f,{target:m.target,pole:m.pole});
});

test('exact folded target=root match preserves current elbow and local rotations', () => {
  const f=fixture({length1:2,length2:2}); f.end.position.x=-2; f.upper.rotation.x=0.9; f.scene.updateMatrixWorld(true);
  const input=matchedInput(f,{previousDirection:[1,0,0]}), result=verify(f,input);
  vectorNear(input.target,point(f.upper));
  assert.equal(result.diagnostics.targetAtRoot,true); assert.equal(result.diagnostics.noOp,true);
});

test('degenerate pole transports an explicit previous bend and root direction', () => {
  const f=fixture({length1:2,length2:2});
  const input={target:[0,0,0],pole:[0,0,0],previousBend:[0,-1,0],previousDirection:[0,0,1]};
  const result=verify(f,input);
  vectorNear(result.elbow,[0,-2,0]);
  assert.equal(result.diagnostics.bendSource,'previous'); assert.equal(result.diagnostics.directionSource,'previous');
});

test('limits clamp explicit per-axis scalar radians and report actual post-clamp endpoint error', () => {
  const f=fixture(), input={target:[1,2.5,0],pole:[0,4,0],limits:{
    upper:{min:[-0.05,-0.04,-0.03],max:[0.05,0.04,0.03]},
    lower:{min:[-0.1,-0.09,-0.08],max:[0.1,0.09,0.08]}}};
  const before=JSON.stringify(input), result=verify(f,input);
  assert.equal(result.diagnostics.reach,'reachable'); assert.equal(result.diagnostics.geometryTargetError,0);
  assert.equal(result.diagnostics.reachClamped,false); assert.equal(result.diagnostics.angleClamped,true);
  assert.equal(result.diagnostics.clamped,true); assert.equal(result.diagnostics.endpointReached,false);
  assert.ok(result.diagnostics.targetError>1); assert.ok(result.diagnostics.analyticEndpointError>1);
  for (const name of ['upper','lower']) result.rotations[name].forEach((v,i)=>{
    assert.ok(v>=input.limits[name].min[i] && v<=input.limits[name].max[i]);
  });
  assert.ok(result.diagnostics.clampedAxes.upper.includes('z'));
  assert.equal(JSON.stringify(input),before);
});

test('angle limits also apply on FK matching and omitted limbs remain unbounded', () => {
  const f=fixture({posed:true}), input={...matchedInput(f),limits:{upper:{min:[0,0,0],max:[0,0,0]}}};
  const result=verify(f,input);
  assert.deepEqual(result.rotations.upper,[0,0,0]);
  assert.deepEqual(result.rotations.lower,[f.lower.rotation.x,f.lower.rotation.y,f.lower.rotation.z]);
  assert.equal(result.diagnostics.noOp,false); assert.equal(result.diagnostics.angleClamped,true);
  assert.ok(result.diagnostics.targetError>0);
});

test('wide valid limits do not change an unconstrained solution; empty limits are allowed', () => {
  const f=fixture({transformed:true}), input={target:worldGoal(f,[2,1,0]),pole:worldGoal(f,[0,3,1])};
  const unrestricted=verify(f,input);
  assert.deepEqual(verify(f,{...input,limits:{}}),unrestricted);
  const bound={min:[-20,-20,-20],max:[20,20,20]};
  assert.deepEqual(verify(f,{...input,limits:{upper:bound,lower:bound}}),unrestricted);
});

test('caller matrices and dirty flags remain unchanged even when stale before solving', () => {
  const f=fixture({transformed:true,posed:true});
  f.parent.position.x+=0.3; f.upper.rotation.y+=0.2; f.lower.position.y+=0.5;
  f.upper.matrixWorldNeedsUpdate=true; f.end.userData.marker={test:true};
  const unrelated=new THREE.PerspectiveCamera(); f.scene.add(unrelated); unrelated.position.set(4,5,6);
  const before=snapshot(f), goal=matchedInput(f), result=solveLimbPose({...chain(f),...goal});
  assert.equal(result.ok,true); assert.equal(result.diagnostics.noOp,true);
  assert.equal(snapshot(f),before);
});

test('synthetic near-straight FK matches remain no-pop even when the stable pole differs from a tiny observed bend', () => {
  for (const angle of [1e-4,1e-6,1e-8,1e-9,-1e-9,0]) for (const transformed of [false,true]) {
    const f=fixture({transformed}); f.upper.rotation.x=0.8; f.lower.rotation.z=angle; f.scene.updateMatrixWorld(true);
    const input=matchedInput(f,{previousBend:[0,0,-1]}), result=verify(f,input);
    assert.equal(result.diagnostics.noOp,true,`angle=${angle}, transformed=${transformed}`);
    const goalsOnly=verify(f,{target:input.target,pole:input.pole});
    assert.equal(goalsOnly.diagnostics.noOp,true,'No opaque match token or hint forwarding is required.');
    assert.deepEqual(result.rotations.upper,[f.upper.rotation.x,f.upper.rotation.y,f.upper.rotation.z]);
    assert.deepEqual(result.rotations.lower,[f.lower.rotation.x,f.lower.rotation.y,f.lower.rotation.z]);
  }
});

test('strict validation rejects malformed goals, hints, option records and unknown fields', () => {
  const f=fixture(), base={...chain(f),target:[1,2,0],pole:[0,4,0]};
  const bad=[null,undefined,1,[],{...base,typo:true}];
  for (const field of ['target','pole','previousBend','previousDirection','preferredBend']) {
    for (const value of [null,undefined,1,{},new THREE.Vector3(1,2,3),[1,2],[1,2,3,4],[1,,3],[1,Infinity,3],[1,NaN,3],['1',2,3]]) bad.push({...base,[field]:value});
  }
  for (const input of bad) { const result=solveLimbPose(input); assert.equal(result.ok,false); assert.equal(result.error.code,'INVALID_INPUT'); finiteJSON(result); }
  for (const input of [null,{...chain(f),preferredBend:null},{...chain(f),target:[0,0,0]}]) assert.equal(matchLimbToIK(input).ok,false);
});

test('strict limit validation rejects scalar bounds, inverted bounds, missing bounds, extra keys and null/undefined', () => {
  const f=fixture(), base={...chain(f),target:[1,2,0],pole:[0,4,0]}, min=[-1,-1,-1], max=[1,1,1];
  const invalid=[null,undefined,1,[],{upper:1},{upper:[1,1,1]},{upper:null},{upper:undefined},{upper:{}},
    {upper:{min,max:1}},{upper:{min,max:[0,0]}},{upper:{min:[2,0,0],max}},
    {upper:{min:[1,,0],max}},{upper:{min,max:[Infinity,1,1]}},{upper:{min,max,units:'degrees'}},{elbow:{min,max}}];
  for (const limits of invalid) {
    const result=solveLimbPose({...base,limits}); assert.equal(result.ok,false); assert.equal(result.error.code,'INVALID_INPUT'); finiteJSON(result);
  }
});

test('actual Bone direct links, nonzero segments and XYZ local order are enforced', () => {
  const f=fixture(), base={...chain(f),target:[1,2,0],pole:[0,4,0]};
  for (const input of [{...base,upper:{}},{...base,lower:new THREE.Object3D()},{...base,end:f.upper},{...base,lower:new THREE.Bone()}]) assert.equal(solveLimbPose(input).ok,false);
  f.upper.rotation.order='ZYX'; assert.equal(solveLimbPose(base).error.field,'upper.rotation.order'); f.upper.rotation.order='XYZ';
  f.lower.position.set(0,0,0); assert.equal(solveLimbPose(base).ok,false);
});

test('scaled actors/chains and matrix-authored transforms are explicitly rejected without caller mutation', () => {
  for (const who of ['scene','parent','upper','lower','end']) for (const scale of [[2,2,2],[1,2,1],[-1,1,1]]) {
    const f=fixture(); f[who].scale.set(...scale); const before=snapshot(f);
    const result=solveLimbPose({...chain(f),target:[1,2,0],pole:[0,4,0]});
    assert.equal(result.ok,false); assert.equal(result.error.code,'UNSUPPORTED_SCALE'); assert.equal(snapshot(f),before);
  }
  for (const flag of ['matrixAutoUpdate','matrixWorldAutoUpdate']) {
    const f=fixture(); f.parent[flag]=false; assert.equal(matchLimbToIK(chain(f)).ok,false);
  }
});

test('nonfinite transforms, nonunit quaternion and numerical range failures return finite explicit error records', () => {
  const fixtures=[];
  let f=fixture(); f.upper.position.x=NaN; fixtures.push(f);
  f=fixture(); f.upper.quaternion.set(1,1,1,1); fixtures.push(f);
  f=fixture(); f.parent.position.x=Number.MAX_VALUE; f.upper.position.x=Number.MAX_VALUE; fixtures.push(f);
  for (const value of fixtures) {
    const result=solveLimbPose({...chain(value),target:[1,2,0],pole:[0,4,0]}); assert.equal(result.ok,false); finiteJSON(result);
  }
  const valid=fixture(), result=solveLimbPose({...chain(valid),target:[Number.MAX_VALUE,Number.MAX_VALUE,0],pole:[0,1,0]});
  assert.equal(result.ok,false); assert.equal(result.error.code,'NUMERIC_RANGE'); finiteJSON(result);
});

test('synthetic parentless Bone chain and noncanonical XYZ Euler branches solve to the reported endpoint', () => {
  for (const y of [1.8,-1.9,Math.PI/2,-Math.PI/2]) {
    const f=fixture({posed:true}); f.parent.remove(f.upper); f.scene=f.upper;
    f.upper.rotation.set(0.8,y,-0.4); f.lower.rotation.set(-0.5,2.1,0.3); f.scene.updateMatrixWorld(true);
    const before=snapshot(f);
    const noOp=verify(f,matchedInput(f)); assert.equal(noOp.diagnostics.noOp,true);
    const solved=verify(f,{target:[1.2,1.1,-0.6],pole:[-0.5,3,0.2]});
    assert.equal(solved.diagnostics.endpointReached,true); assert.equal(snapshot(f),before);
  }
});

test('returned JSON arrays are detached from bones and goals; repeat calls own no state', () => {
  const f=fixture({posed:true}), input={...matchedInput(f)}, expected=solveLimbPose({...chain(f),...input});
  const before=snapshot(f), goals=JSON.stringify(input), result=solveLimbPose({...chain(f),...input});
  result.rotations.upper[0]=99; result.end[1]=99; result.bendInfo.bendDirection[2]=99;
  const match=matchLimbToIK(chain(f)); match.target[0]=99; match.pole[0]=99;
  assert.equal(snapshot(f),before); assert.equal(JSON.stringify(input),goals);
  assert.deepEqual(solveLimbPose({...chain(f),...input}),expected);
});

test('synthetic deterministic general-pose fixtures are finite, immutable and FK match without a pop', () => {
  let seed=0x67ca31;
  const random=()=> {seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const v=()=> Array.from({length:3},()=> (random()-0.5)*2.5);
  for (let i=0;i<120;i++) {
    const f=fixture({transformed:true,length1:0.7+random()*2,length2:0.7+random()*2});
    f.upper.rotation.set(...v()); f.lower.rotation.set(...v()); f.scene.updateMatrixWorld(true);
    const before=snapshot(f), matched=verify(f,matchedInput(f));
    assert.equal(matched.diagnostics.noOp,true);
    assert.deepEqual(matched.rotations.upper,[f.upper.rotation.x,f.upper.rotation.y,f.upper.rotation.z]);
    assert.deepEqual(matched.rotations.lower,[f.lower.rotation.x,f.lower.rotation.y,f.lower.rotation.z]);
    const root=point(f.upper), target=root.map((x,j)=>x+v()[j]);
    verify(f,{target,pole:root.map((x,j)=>x+v()[j])});
    assert.equal(snapshot(f),before);
  }
});
