import test from 'node:test';
import assert from 'node:assert/strict';
import {createSceneController,activeProxy} from '../scene-controller.js';
import {defaults,normalizeState,stableState} from '../web/state.js';
import {SCENE_SCHEMA,validateSceneState} from '../web/scene-state.js';
import fs from 'node:fs';

// Deliberately tiny runtime double: controller tests do not claim GPU evidence.
function fixture(){
 const created=[],changes=[],selections=[];let failure=null,fits=0;
 const createActor=record=>{
  if(failure===record.id)throw Error('construction failed');
  const state=structuredClone(record.state),actor={id:record.id,state,visible:true,active:true,disposed:0,
   rig:{id:record.id,read(){return this.id;}},body:{id:record.id,read(){return this.id;}},
   setActive(value){this.active=value;},setVisible(value){this.visible=value;},
   setPlacement(value){this.placement=structuredClone(value);if(failure==='placement')throw Error('placement failed');},
   update(next){if(next){for(const key of Object.keys(state))delete state[key];Object.assign(state,structuredClone(next));}},
   dispose(){this.disposed++;}};
  created.push(actor);return actor;
 };
 const controller=createSceneController({createActor,changed:kind=>changes.push(kind),selected:actor=>selections.push(actor.id),fit:()=>fits++});
 return {controller,created,changes,selections,fail:value=>failure=value,get fits(){return fits;}};
}
function scene(controller){controller.setMode('multi');return controller.serialize();}

test('initial state preserves legacy schema; canonical actor placeholders do not own globals',()=>{
 const {controller:c}=fixture();assert.deepEqual(c.serialize(),defaults());assert.equal(c.isScene(),false);
 assert.equal(c.runtime().state.view,'body');assert.equal(c.state.view,'portrait');c.state.alpha=true;c.state.view='sheet';
 assert.equal(c.runtime().state.alpha,false);assert.equal(c.runtime().state.view,'body');assert.equal(c.serialize().alpha,true);c.dispose();
});
test('selected state facade enumerates and deletes real character/global fields with stable identity',()=>{
 const {controller:c}=fixture(),state=c.state,first=c.runtime().state;
 c.state.morphs.width=.4;c.state.canvas={width:500,height:700,background:'#333e4a'};
 const copied=structuredClone({...state});assert.equal(copied.view,'portrait');assert.equal(copied.morphs.width,.4);
 const id=c.addActor();assert.equal(c.state,state);assert.notEqual(c.runtime().state,first);assert.deepEqual(state.morphs,{});assert.equal(state.canvas.width,500);
 delete state.canvas;assert.equal(Object.hasOwn(state,'canvas'),false);c.selectActor('actor-1');assert.equal(state.morphs.width,.4);c.selectActor(id);c.dispose();
});
test('multi selection is editor-only and leaves canonical render hash unchanged',()=>{
 const {controller:c,changes}=fixture();c.addActor();const before=stableState(c.serialize());c.selectActor('actor-1');
 assert.equal(changes.at(-1),'editor');assert.equal(stableState(c.serialize()),before);assert.equal(c.runtime().active,true);
 assert.equal(c.allActors().filter(a=>a.active).length,1);c.dispose();
});
test('single mode retains extras and respects the stored actor visibility',()=>{
 const {controller:c}=fixture();const second=c.addActor();c.setVisible(false);c.setMode('single');
 assert.equal(c.getActors().length,2);assert.equal(c.serialize().soloActor,second);assert.deepEqual(c.visibleActors(),[]);assert.equal(c.runtime(second).visible,false);assert.equal(c.serialize().schema,SCENE_SCHEMA);
 c.selectActor('actor-1');assert.equal(c.serialize().soloActor,'actor-1');assert.equal(c.visibleActors()[0].id,'actor-1');
 c.setMode('multi');assert.deepEqual(c.visibleActors().map(a=>a.id),['actor-1']);assert.equal(c.getActors()[1].visible,false);c.dispose();
});
test('blank addition and deep duplicate own state, offsets and appearance without touching neighbors',()=>{
 const {controller:c}=fixture();c.state.sex=.7;c.state.skin='#123456';c.state.morphs.width=.6;c.state.pose.head=[.1,.2,0];c.state.expressions.smile=.5;
 const source=structuredClone(c.runtime().state),duplicate=c.duplicateActor();assert.deepEqual(c.runtime(duplicate).state,source);
 assert.notEqual(c.runtime(duplicate).state.pose.head,c.runtime('actor-1').state.pose.head);assert.equal(c.getActors()[1].position[0],6);
 c.state.pose.head[0]=.9;assert.equal(c.runtime('actor-1').state.pose.head[0],.1);
 const blank=c.addActor();assert.equal(c.runtime(blank).state.sex,0);assert.deepEqual(c.runtime(blank).state.pose,{});assert.equal(c.runtime(blank).state.skin,defaults().skin);c.dispose();
});
test('four-actor and last-actor guards fail before allocations or list mutation',()=>{
 const {controller:c,created}=fixture();assert.throws(()=>c.removeActor(),/последнего/);c.addActor();c.addActor();c.addActor();
 const before=c.serialize(),count=created.length;assert.throws(()=>c.addActor(),/4/);assert.throws(()=>c.duplicateActor(),/4/);
 assert.equal(created.length,count);assert.deepEqual(c.serialize(),before);c.dispose();
});
test('delete disposes only target and later additions never reuse the removed id',()=>{
 const {controller:c}=fixture();const id=c.addActor(),target=c.runtime(),survivor=c.runtime('actor-1');c.removeActor();
 assert.equal(target.disposed,1);assert.equal(survivor.disposed,0);assert.equal(c.getSelected(),'actor-1');assert.notEqual(c.addActor(),id);c.dispose();assert.equal(survivor.disposed,1);
});
test('metadata is detached; placements validate together and never alter pose or another actor',()=>{
 const {controller:c}=fixture();const second=c.addActor(),other=c.runtime('actor-1');c.state.pose.head=[.2,0,0];const before=structuredClone(c.runtime().state);
 c.setPlacement({position:[8,2,-3],rotation:[0,Math.PI/2,0]});assert.deepEqual(c.runtime().state,before);assert.deepEqual(other.placement.position,[0,0,0]);
 const metadata=c.getActors();metadata[1].position[0]=999;assert.equal(c.getActors()[1].position[0],8);
 const placement=structuredClone(c.runtime().placement);assert.throws(()=>c.setPlacement({position:[20,0,0],rotation:[0,4,0]}));assert.deepEqual(c.runtime().placement,placement);
 c.resetPlacement(second);assert.deepEqual(c.getActors()[1].position,[0,0,0]);c.fit();c.dispose();
});
test('serializing uses runtime-owned cloned state, not stale source records or a selected root mirror',()=>{
 const {controller:c}=fixture();c.addActor();c.runtime('actor-1').state.sex=.8;c.runtime().state.sex=.2;
 const s=c.serialize();assert.equal(s.actors[0].state.sex,.8);assert.equal(s.actors[1].state.sex,.2);assert.equal(Object.hasOwn(s,'sex'),false);
 for(const a of s.actors){assert.equal(a.state.view,'body');assert.equal(a.state.alpha,false);assert.equal(Object.hasOwn(a.state,'canvas'),false);}
 assert.deepEqual(normalizeState(s),s);s.actors[0].state.sex=0;assert.equal(c.runtime('actor-1').state.sex,.8);c.dispose();
});
test('full scene restore builds all new runtimes before old disposal and restores selected metadata',()=>{
 const f=fixture(),c=f.controller;c.addActor();const saved=c.serialize(),old=c.allActors();saved.actors[0].state.sex=.9;
 c.replace(saved,'actor-1');assert.equal(c.getSelected(),'actor-1');assert.equal(c.state.sex,.9);assert.ok(old.every(a=>a.disposed===1));
 assert.equal(f.selections.at(-1),'actor-1');assert.equal(c.allActors().filter(a=>a.active).length,1);c.dispose();
});
test('invalid documents or selected IDs fail before any runtime construction',()=>{
 const f=fixture(),c=f.controller,input=scene(c),before=c.serialize(),count=f.created.length;
 for(const bad of [{...input,schema:'unknown'}, {...input,soloActor:'missing'}, {...input,actors:[]}, {...input,actors:[{...input.actors[0],position:[Infinity,0,0]}]}])assert.throws(()=>c.replace(bad));
 assert.throws(()=>c.replace(input,'missing'));assert.equal(f.created.length,count);assert.deepEqual(c.serialize(),before);c.dispose();
});
test('construction failure cleans up candidates and leaves every old runtime/state selected and undisposed',()=>{
 const f=fixture(),c=f.controller;c.addActor();const saved=c.serialize(),old=c.allActors(),selected=c.getSelected();f.fail(saved.actors[1].id);
 const before=f.created.length;assert.throws(()=>c.replace(saved),/construction/);assert.equal(f.created[before].disposed,1);
 assert.deepEqual(c.allActors(),old);assert.equal(c.getSelected(),selected);assert.deepEqual(c.serialize(),saved);assert.ok(old.every(a=>a.disposed===0));f.fail(null);c.dispose();
});
test('placement failure disposes its newly constructed actor and preserves the original scene',()=>{
 const f=fixture(),c=f.controller,saved=scene(c),old=c.runtime();f.fail('placement');assert.throws(()=>c.replace(saved),/placement/);
 assert.equal(f.created.at(-1).disposed,1);assert.equal(c.runtime(),old);assert.equal(old.disposed,0);assert.deepEqual(c.serialize(),saved);f.fail(null);c.dispose();
});
test('full preview restore returns to legacy single rather than keeping scene metadata',()=>{
 const {controller:c}=fixture();c.addActor();c.replace({...defaults(),sex:1});assert.equal(c.getActors().length,1);assert.equal(c.isScene(),false);assert.equal(c.serialize().schema,'character-3d-preview/1');assert.equal(c.state.sex,1);c.dispose();
});
test('retained rig/body facades bind methods to the currently selected real object',()=>{
 const {controller:c}=fixture(),rig=activeProxy(()=>c.runtime().rig),body=activeProxy(()=>c.runtime().body);
 assert.equal(rig.read(),'actor-1');const next=c.addActor();assert.equal(rig.read(),next);assert.equal(body.read(),next);assert.equal({...rig}.id,next);
 c.selectActor('actor-1');assert.equal(body.read(),'actor-1');c.dispose();
});
test('dispose releases every runtime once and rejects later operations',()=>{
 const {controller:c,created}=fixture();c.addActor();c.dispose();c.dispose();assert.ok(created.every(a=>a.disposed===1));assert.throws(()=>c.serialize(),/закрыта/);assert.throws(()=>c.addActor(),/закрыта/);
});

// CPU-only boundary regressions use the actual actor factory and vendored Three;
// this is geometry/state evidence, not a browser, GPU or PNG claim.
async function realFixture(){
 await import('./register-three-alias.mjs');
 const THREE=await import('../vendor/three.module.js');
 const {createCharacterActor}=await import('../character-actor.js');
 const {connectIdentity}=await import('../identity-morphs.js');
 const load=name=>JSON.parse(fs.readFileSync(new URL('../assets/'+name,import.meta.url),'utf8'));
 const data=load('human.json'),rigData=load('face-rig.json'),face=load('face-morphs.json'),partsData=load('face-parts.json').parts,contactDefinition=load('face-contact.json');
 data.morphs.push(...face.morphs);connectIdentity(load('identity.json'),data,rigData,partsData.map(source=>({source})));
 const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-20,20,20,-20,.01,1000),canvas=new EventTarget(),orbit={enabled:true},eyeTexture=new THREE.Texture();
 canvas.style={};canvas.ownerDocument={pointerLockElement:null};
 const controller=createSceneController({createActor:record=>createCharacterActor({id:record.id,state:record.state,data,rigData,partsData,contactDefinition,eyeTexture,scene,camera,canvas,orbit})});
 const vertices=mesh=>{const v=new THREE.Vector3(),out=[];for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,v);out.push(v.x,v.y,v.z);}return out;};
 return {controller,vertices,dispose(){controller.dispose();eyeTexture.dispose();}};
}
for(const [label,unit] of [['ASCII','A'],['astral Unicode','😀']])test(`duplicate of a 64-codepoint ${label} name remains canonical and owns independent geometry`,async()=>{
 const f=await realFixture(),c=f.controller;
 try{
  const name=unit.repeat(64),suffix=' · копия';assert.equal([...name].length,64);
  c.renameActor(name);c.state.sex=.3;c.state.pose.head=[.1,.15,0];c.state.morphs.identity_head_width=.4;c.state.expressions.smile_l=.5;c.runtime().update();
  c.setPlacement({position:[9,2,-4],rotation:[.1,.4,-.1]});
  const first=c.runtime(),sourceState=structuredClone(first.state),body=f.vertices(first.body),eyes=f.vertices(first.eyes),parts=first.parts.map(p=>f.vertices(p.mesh));
  const id=c.duplicateActor(),second=c.runtime(),saved=c.serialize();
  assert.deepEqual(normalizeState(saved),saved);assert.deepEqual(validateSceneState(saved,normalizeState),saved);
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(saved))),saved);assert.doesNotThrow(()=>stableState(saved));
  assert.equal(saved.actors.length,2);assert.equal(saved.actors[0].name,name);
  assert.equal(saved.actors[1].name,[...name].slice(0,64-[...suffix].length).join('')+suffix);assert.ok([...saved.actors[1].name].length<=64);
  assert.equal(second.id,id);assert.deepEqual(second.state,sourceState);assert.notEqual(second.state,first.state);assert.notEqual(second.state.pose.head,first.state.pose.head);
  assert.notEqual(second.state.morphs,first.state.morphs);assert.notEqual(second.state.expressions,first.state.expressions);
  assert.notEqual(second.body.geometry,first.body.geometry);assert.notEqual(second.body.skeleton,first.body.skeleton);
  assert.notEqual(second.eyes.geometry,first.eyes.geometry);second.parts.forEach((p,i)=>assert.notEqual(p.mesh.geometry,first.parts[i].mesh.geometry));
  // Different root placements quantize the rig's Float32 bone matrices.
  // Reuse the existing placed-rig 1e-6 dm tolerance, not bitwise coordinates.
  const duplicateBody=f.vertices(second.body);assert.equal(duplicateBody.length,body.length);
  for(let i=0;i<body.length;i+=3){const distance=Math.hypot(duplicateBody[i]-body[i],duplicateBody[i+1]-body[i+1],duplicateBody[i+2]-body[i+2]);assert.ok(distance<1e-6,`placed duplicate vertex ${i/3}: ${distance} dm`);}
  assert.deepEqual(saved.actors[1].position,[15,2,-4]);assert.deepEqual(saved.actors[1].rotation,[.1,.4,-.1]);
  c.state.sex=.9;c.state.pose.head[0]=.4;c.state.morphs.identity_head_width=-.3;c.state.expressions.smile_l=.1;second.update();
  assert.notDeepEqual(f.vertices(second.body),body);assert.deepEqual(first.state,sourceState);
  assert.deepEqual(f.vertices(first.body),body);assert.deepEqual(f.vertices(first.eyes),eyes);first.parts.forEach((p,i)=>assert.deepEqual(f.vertices(p.mesh),parts[i]));
  const edited=c.serialize();assert.deepEqual(normalizeState(edited),edited);assert.deepEqual(validateSceneState(edited,normalizeState),edited);
  c.selectActor(first.id);assert.equal(stableState(c.serialize()),stableState(edited));
 }finally{f.dispose();}
});
for(const operation of ['addActor','duplicateActor'])test(`${operation} rejects an invalid complete candidate before allocation or runtime mutation`,()=>{
 const f=fixture(),c=f.controller;
 try{
  c.addActor();c.selectActor('actor-1');
  for(const invalidate of [
   ()=>{c.runtime().state.pose.head=[.1,.2];},
   ()=>{c.runtime('actor-2').state.pose.head=[.1,.2];},
   ()=>{c.shared.canvas={width:-1,height:700,background:'#333e4a'};},
  ]){
   const valid=c.serialize();invalidate();
   const old=c.allActors(),metadata=c.getActors(),states=old.map(a=>structuredClone(a.state)),shared=structuredClone(c.shared),selected=c.getSelected(),mode=c.getMode(),isScene=c.isScene(),allocations=f.created.length,changes=f.changes.length,selections=f.selections.length;
   assert.throws(()=>c[operation]());
   assert.equal(f.created.length,allocations);assert.deepEqual(c.getActors(),metadata);assert.deepEqual(c.allActors(),old);
   assert.equal(c.getSelected(),selected);assert.equal(c.getMode(),mode);assert.equal(c.isScene(),isScene);assert.deepEqual(c.shared,shared);
   assert.equal(f.changes.length,changes);assert.equal(f.selections.length,selections);
   old.forEach((actor,i)=>{assert.equal(c.runtime(actor.id),actor);assert.deepEqual(actor.state,states[i]);assert.equal(actor.disposed,0);});
   c.replace(valid,selected);assert.deepEqual(c.serialize(),valid);
  }
 }finally{c.dispose();}
});
for(const operation of ['addActor','duplicateActor'])test(`${operation} placement allocation failure is atomic and disposes only the candidate`,()=>{
 const f=fixture(),c=f.controller;
 try{
  const before=c.serialize(),old=c.runtime(),selected=c.getSelected(),changes=f.changes.length,selections=f.selections.length;f.fail('placement');
  assert.throws(()=>c[operation](),/placement/);assert.equal(f.created.at(-1).disposed,1);
  assert.equal(c.runtime(),old);assert.equal(old.disposed,0);assert.equal(c.getSelected(),selected);assert.equal(c.getMode(),'single');assert.equal(c.isScene(),false);
  assert.equal(c.getActors().length,1);assert.deepEqual(c.serialize(),before);assert.equal(f.changes.length,changes);assert.equal(f.selections.length,selections);
 }finally{f.fail(null);c.dispose();}
});
