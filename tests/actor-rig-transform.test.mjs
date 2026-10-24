import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.js';
import {attachRig} from '../rig-controller.js';
import {defaults} from '../web/state.js';
const data=JSON.parse(fs.readFileSync(new URL('../assets/human.json',import.meta.url),'utf8'));
const asset=JSON.parse(fs.readFileSync(new URL('../assets/face-rig.json',import.meta.url),'utf8'));
function fixture({actorLocal=true,placed=false}={}){
 const scene=new THREE.Scene(),root=new THREE.Group();scene.add(root);
 if(placed){root.position.set(7,-2,3);root.rotation.set(.1,.6,-.2);}
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));geometry.setIndex(data.indices);
 const material=new THREE.MeshBasicMaterial(),body=new THREE.Mesh(geometry,material);root.add(body);
 const canvas=new EventTarget();canvas.style={};canvas.ownerDocument={pointerLockElement:null};
 const camera=new THREE.OrthographicCamera(-10,10,10,-10,.01,1000);camera.position.z=50;camera.updateMatrixWorld(true);
 const state={...defaults(),view:'body',free:true};let changes=0;
 const orbit={enabled:true},rig=attachRig(body,null,data,asset,root,camera,canvas,orbit,()=>changes++,[],actorLocal?{displayScene:scene}:{});rig.bind(state);
 // Production defaults deliberately hide joint dots; opt in to the overlays
 // being measured rather than changing the runtime's legacy layer defaults.
 rig.setEditor({rigLayers:{bones:true,joints:true,face:true}});
 return {scene,root,rig,state,canvas,orbit,changes:()=>changes,dispose(){rig.dispose();geometry.dispose();material.dispose();}};
}
function close(a,b,epsilon=1e-6){assert.ok(a.distanceTo(b)<epsilon,`distance ${a.distanceTo(b)}`);}
test('rig placement skins once, survives rebind, and projects helpers into global scene',()=>{
 const f=fixture();try{
  f.state.pose.head=[.1,.2,.1];f.rig.apply(f.state);
  const local=f.rig.body.getVertexPosition(12000,new THREE.Vector3());
  f.root.position.set(7,-2,3);f.root.rotation.set(.1,.6,-.2);f.scene.updateMatrixWorld(true);f.rig.apply(f.state);f.rig.projectHelpers();
  const expected=local.clone().applyMatrix4(f.root.matrixWorld);
  close(f.rig.body.getVertexPosition(12000,new THREE.Vector3()).applyMatrix4(f.rig.body.matrixWorld),expected);
  f.rig.bind(f.state);close(f.rig.body.getVertexPosition(12000,new THREE.Vector3()).applyMatrix4(f.rig.body.matrixWorld),expected);
  assert.equal(f.scene.children.find(o=>o.name==='RigDisplayLayers')?.parent,f.scene);
  assert.ok(!f.root.children.some(o=>o.name==='RigDisplayLayers'||o.isTransformControlsRoot));
  const helper=f.scene.children.find(o=>o.name==='RigDisplayLayers'),dots=helper.children.find(o=>o.isPoints);
  const records=f.rig.jointRecords().filter(r=>f.rig.pickCategories().includes(r.category));
  assert.equal(dots.geometry.drawRange.count,records.length);
  records.forEach((r,i)=>close(new THREE.Vector3().fromBufferAttribute(dots.geometry.attributes.position,i).applyMatrix4(dots.matrixWorld),new THREE.Vector3(...r.position),2e-6));
 }finally{f.dispose();}
});
test('inactive rig refuses joint selection, hides helpers, and emits no initialization callbacks',()=>{
 const f=fixture();try{
  assert.equal(f.changes(),0);const selected=f.rig.values().name;
  f.rig.setActive(false);f.rig.select(0);f.rig.projectHelpers();
  assert.equal(f.rig.values().name,selected);assert.equal(f.rig.metrics().display.controller,false);assert.equal(f.rig.metrics().display.joints,0);
  assert.equal(f.rig.pointerBusy(),false);assert.equal(f.changes(),0);
 }finally{f.dispose();}
});
test('binding an already placed actor uses placement-independent inverse binds across repeated morph refits',()=>{
 const a=fixture(),b=fixture({placed:true});try{
  assert.equal(a.rig.body.bindMode,'attached');assert.equal(b.rig.body.bindMode,'attached');
  for(const sex of [0,.35,1,0]){
   a.state.sex=b.state.sex=sex;a.state.pose=b.state.pose={head:[.1,.2,-.1],jaw:[.12,0,0]};
   for(let repeat=0;repeat<4;repeat++){
    a.rig.bind(a.state);b.rig.bind(b.state);
    assert.deepEqual(b.rig.body.skeleton.boneInverses.map(m=>m.toArray()),a.rig.body.skeleton.boneInverses.map(m=>m.toArray()));
    for(const index of [0,1000,12000,data.positions.length/3-1])close(b.rig.body.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(b.rig.body.matrixWorld),a.rig.body.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(b.root.matrixWorld));
   }
   b.root.position.add(new THREE.Vector3(-2,1,3));b.root.rotation.y+=.2;
  }
 }finally{a.dispose();b.dispose();}
});
test('legacy attachRig remains detached with unchanged world inverse-bind semantics',()=>{
 const f=fixture({actorLocal:false,placed:true});try{
  assert.equal(f.rig.body.bindMode,'detached');
  f.rig.bones.forEach((bone,i)=>assert.deepEqual(f.rig.body.skeleton.boneInverses[i].toArray(),bone.matrixWorld.clone().invert().toArray()));
  assert.equal(f.root.children.find(o=>o.name==='RigDisplayLayers')?.parent,f.root);
  for(let i=0;i<4;i++){f.rig.bind(f.state);close(f.rig.body.getVertexPosition(12000,new THREE.Vector3()),new THREE.Vector3().fromBufferAttribute(f.rig.body.geometry.attributes.position,12000));}
 }finally{f.dispose();}
});
test('inactive/export-hidden/sheet rigs guard every control callback and restored helpers cannot reactivate them',()=>{
 const f=fixture();try{
  f.rig.setLimbMode('arm.L','ik');
  const gizmo=f.scene.children.find(o=>o.isTransformControlsRoot),controls=gizmo.controls;
  for(const hidden of ['inactive','export','sheet']){
   const snapshot=f.rig.snapshotHelpers();
   if(hidden==='inactive')f.rig.setActive(false);else if(hidden==='export')f.rig.hideHelpers();else{f.state.view='sheet';f.rig.viewChanged();}
   const state=JSON.stringify(f.state),editor=f.rig.editorState(),changes=f.changes();
   f.rig.select(0);f.rig.rotation('x',20);f.rig.preset('portrait');f.rig.selectLimb('leg.R');f.rig.selectIKHandle('arm.L','pole');f.rig.setLimbMode('arm.L','fk');f.rig.setLimbGoal('arm.L','target',[0,0,0]);f.rig.setMode('translate');f.rig.setGoalDrag(true);
   controls.dispatchEvent({type:'change'});controls.dispatchEvent({type:'objectChange'});controls.dispatchEvent({type:'dragging-changed',value:true});
   assert.equal(JSON.stringify(f.state),state);assert.deepEqual(f.rig.editorState(),editor);assert.equal(f.changes(),changes);assert.equal(f.orbit.enabled,hidden!=='sheet');
   assert.deepEqual(f.rig.jointRecords(),[]);assert.deepEqual(f.rig.ikGoalRecords(),[]);assert.deepEqual(f.rig.pickCategories(),[]);assert.equal(f.rig.pointerBusy(),false);assert.equal(controls.enabled,false);assert.equal(controls.object,undefined);
   if(hidden!=='export'){f.rig.hideHelpers();f.rig.restoreHelpers(snapshot);assert.equal(f.rig.metrics().display.controller,false);}
   if(hidden==='inactive')f.rig.setActive(true);else if(hidden==='export')f.rig.restoreHelpers(snapshot);else{f.state.view='body';f.rig.viewChanged();}
   assert.ok(controls.enabled);assert.ok(f.rig.metrics().display.controller);
  }
 }finally{f.dispose();}
});
test('setEditor and helper restoration are silent even when switching controller mode and attachment',()=>{
 const f=fixture();try{
  f.rig.setLimbMode('arm.L','ik');const before=f.changes();
  f.rig.setEditor({selectedJoint:'jaw',rigLayers:{joints:true,face:true}});
  const snapshot=f.rig.snapshotHelpers();f.rig.hideHelpers();f.rig.restoreHelpers(snapshot);f.rig.setEditor({activeLimb:'arm.L',ikHandle:'pole',rigLayers:{joints:true,face:true}});
  assert.equal(f.changes(),before);
 }finally{f.dispose();}
});
test('all four IK targets/poles roundtrip world/local coordinates and follow later actor placement without goal drift',()=>{
 const f=fixture({placed:true}),names={'arm.L':['upperarm_l','hand_l'],'arm.R':['upperarm_r','hand_r'],'leg.L':['thigh_l','foot_l'],'leg.R':['thigh_r','foot_r']};try{
  for(const [id,[upper]]of Object.entries(names)){
   f.rig.setLimbMode(id,'ik');const goal=f.rig.kinematicValues().goals;
   const start=new THREE.Vector3(...f.rig.goalFromWorld(f.rig.bones.find(b=>b.name===upper).getWorldPosition(new THREE.Vector3()))),target=start.lerp(new THREE.Vector3(...goal.target),.8);target.z+=.2;
   f.rig.setLimbGoal(id,'target',f.rig.goalFromWorld(target.clone().applyMatrix4(f.root.matrixWorld)));
  }
  const goals=structuredClone(f.state.kinematics),controllers=f.scene.children.find(o=>o.isTransformControlsRoot).controls;
  for(const [position,rotation]of [[[7,-2,3],[.1,.6,-.2]],[[-4,2,8],[-.3,-.5,.2]],[[0,0,0],[0,0,0]]]){
   f.root.position.fromArray(position);f.root.rotation.set(...rotation);f.rig.bind(f.state);
   for(const [id,[,end]]of Object.entries(names)){
    const world=new THREE.Vector3(...goals.limbs[id].target).applyMatrix4(f.root.matrixWorld);
    close(f.rig.bones.find(b=>b.name===end).getWorldPosition(new THREE.Vector3()),world);
    close(new THREE.Vector3(...f.rig.goalFromWorld(world)),new THREE.Vector3(...goals.limbs[id].target));
    assert.deepEqual(f.state.kinematics.limbs[id].target,goals.limbs[id].target);assert.deepEqual(f.state.kinematics.limbs[id].pole,goals.limbs[id].pole);
    for(const kind of ['target','pole']){
     f.rig.selectIKHandle(id,kind);assert.equal(controllers.space,'world');
     close(controllers.object.getWorldPosition(new THREE.Vector3()),new THREE.Vector3(...goals.limbs[id][kind]).applyMatrix4(f.root.matrixWorld));
    }
   }
   for(const record of f.rig.ikGoalRecords()){const [limb,kind]=record.id.split(':');close(new THREE.Vector3(...record.position),new THREE.Vector3(...goals.limbs[limb][kind]).applyMatrix4(f.root.matrixWorld));}
  }
 }finally{f.dispose();}
});
