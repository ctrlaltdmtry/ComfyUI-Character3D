// CPU assertions use the production vendored Three, real authored assets and
// minimal canvas EventTarget. They are not WebGL/pixel-parity evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.js';
import {createCharacterActor} from '../character-actor.js';
import {attachRig} from '../rig-controller.js';
import {attachFaceContact} from '../face-contact.js';
import {connectIdentity,blendMorph} from '../identity-morphs.js';
import {defaults} from '../web/state.js';
const load=name=>JSON.parse(fs.readFileSync(new URL('../assets/'+name,import.meta.url),'utf8'));
const data=load('human.json'),rigData=load('face-rig.json'),face=load('face-morphs.json'),parsedParts=load('face-parts.json'),partsData=parsedParts.parts||parsedParts,contactDefinition=load('face-contact.json');
data.morphs.push(...face.morphs);connectIdentity(load('identity.json'),data,rigData,partsData.map(source=>({source})));
function environment(){const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-10,10,10,-10,.01,1000),canvas=new EventTarget();camera.position.z=50;camera.updateMatrixWorld(true);canvas.style={};canvas.ownerDocument={pointerLockElement:null};return {scene,camera,canvas,orbit:{enabled:true}};}
function options(extra={}){return {id:'actor',state:{...defaults(),view:'body',free:true},data,rigData,partsData,contactDefinition,...environment(),...extra};}
function close(a,b,epsilon=2e-6){assert.equal(a.length,b.length);let error=0;for(let i=0;i<a.length;i++)error=Math.max(error,Math.abs(a[i]-b[i]));assert.ok(error<=epsilon,'max coordinate error '+error);}
function vertices(mesh,world=false){mesh.updateMatrixWorld(true);const out=[],v=new THREE.Vector3();for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,v);if(world)v.applyMatrix4(mesh.matrixWorld);out.push(v.x,v.y,v.z);}return out;}
function transformed(values,matrix){const v=new THREE.Vector3(),out=[];for(let i=0;i<values.length;i+=3){v.fromArray(values,i).applyMatrix4(matrix).toArray(out,i);}return out;}
function disposeAll(...actors){for(const actor of actors)actor?.dispose();}
test('all geometry/skin/UV buffers, bones, materials and state are actor-owned; sources stay unchanged',()=>{
 const opt=options(),before=JSON.stringify([data,rigData,partsData,contactDefinition]),texture=new THREE.Texture();const a=createCharacterActor({...opt,id:'a',eyeTexture:texture}),b=createCharacterActor({...opt,id:'b',eyeTexture:texture});
 try{
  assert.notEqual(a.state,b.state);assert.notEqual(a.state,opt.state);assert.notEqual(a.rig.bones[0],b.rig.bones[0]);assert.notEqual(a.body.skeleton,b.body.skeleton);
  for(const [x,y]of [[a.body,b.body],[a.eyes,b.eyes],...a.parts.map((p,i)=>[p.mesh,b.parts[i].mesh])]){
   assert.notEqual(x.geometry,y.geometry);assert.notEqual(x.material,y.material);assert.notEqual(x.geometry.index.array,y.geometry.index.array);
   for(const key of Object.keys(x.geometry.attributes))assert.notEqual(x.geometry.attributes[key].array,y.geometry.attributes[key].array);
  }
  assert.equal(a.eyes.material.map,texture);assert.equal(b.eyes.material.map,texture);
  const other=vertices(b.body),otherEye=vertices(b.eyes),otherParts=b.parts.map(p=>vertices(p.mesh)),updates=b.metrics().updates;
  a.state.sex=1;a.state.material='skin';a.state.skin='#123456';a.state.expressions.eye_close_l=1;a.state.pose.head=[.1,.2,0];a.state.pose.jaw=[.1,0,0];
  const morph=data.morphs.find(m=>m.id.startsWith('identity_'));a.state.morphs[morph.id]=.4;a.update();
  assert.notDeepEqual(vertices(a.body),other);close(vertices(b.body),other);close(vertices(b.eyes),otherEye);b.parts.forEach((p,i)=>close(vertices(p.mesh),otherParts[i]));assert.equal(b.metrics().updates,updates);assert.notEqual(a.material.color.getHex(),b.material.color.getHex());
  assert.equal(JSON.stringify([data,rigData,partsData,contactDefinition]),before);
 }finally{disposeAll(a,b);texture.dispose();}
});
test('placement moves posed body, both eyes, all mouth parts and skeleton exactly once, including rebind',()=>{
 const actor=createCharacterActor(options({state:{...defaults(),free:true,pose:{head:[.1,.2,.1],jaw:[.12,0,0]}}}));
 try{
  const meshes=[actor.body,actor.eyes,...actor.parts.map(p=>p.mesh)],before=meshes.map(m=>vertices(m,true)),bones=actor.rig.jointRecords();
  actor.setPlacement({position:[8,-3,4],rotation:[.1,.7,-.2]});
  meshes.forEach((mesh,i)=>close(vertices(mesh,true),transformed(before[i],actor.root.matrixWorld),1e-5));
  actor.rig.jointRecords().forEach((r,i)=>close(r.position,transformed(bones[i].position,actor.root.matrixWorld),1e-6));
  actor.update();meshes.forEach((mesh,i)=>close(vertices(mesh,true),transformed(before[i],actor.root.matrixWorld),1e-5));
  assert.ok(actor.root.children.every(o=>o.isSkinnedMesh||o.name==='CharacterArmature'));
 }finally{actor.dispose();}
});
test('IK uses actor-local goals under translation/rotation and only changes its own skeleton',()=>{
 const env=environment(),a=createCharacterActor(options({...env,id:'a'})),b=createCharacterActor(options({...env,id:'b'}));
 try{
  a.setPlacement({position:[9,1,-4],rotation:[.2,.6,-.1]});const other=vertices(b.body);
  a.rig.setLimbMode('arm.L','ik');const goal=a.rig.kinematicValues().goals.target;goal[2]+=.3;a.rig.setLimbGoal('arm.L','target',goal);
  const expected=new THREE.Vector3(...goal).applyMatrix4(a.root.matrixWorld),end=a.rig.bones.find(bone=>bone.name==='hand_l').getWorldPosition(new THREE.Vector3());
  close(end.toArray(),expected.toArray());close(vertices(b.body),other);assert.ok(a.rig.metrics().kinematics.limbs['arm.L'].ok);
  const before=vertices(a.body);for(let i=0;i<5;i++)a.update();close(vertices(a.body),before,1e-5);
 }finally{disposeAll(a,b);}
});
test('bounds are actual posed world vertices and the neutral face subset, not transformed local AABBs',()=>{
 const actor=createCharacterActor(options());try{
  actor.setPlacement({position:[5,3,-2],rotation:[.2,.5,-.1]});const measured=actor.bounds(),full=new THREE.Box3(),face=new THREE.Box3(),v=new THREE.Vector3(),p=actor.body.geometry.attributes.position,neutral=actor.body.geometry.boundingBox,threshold=neutral.max.y-(neutral.max.y-neutral.min.y)*.17;
  for(let i=0;i<p.count;i++){actor.body.getVertexPosition(i,v);v.applyMatrix4(actor.body.matrixWorld);full.expandByPoint(v);if(p.getY(i)>=threshold)face.expandByPoint(v);}
  close(measured.bodyBounds.min.toArray(),full.min.toArray());close(measured.bodyBounds.max.toArray(),full.max.toArray());close(measured.faceBounds.min.toArray(),face.min.toArray());close(measured.faceBounds.max.toArray(),face.max.toArray());
 }finally{actor.dispose();}
});
test('inactive/hidden actors have no selectable joints/controllers; helper snapshots restore idempotently',()=>{
 let changes=0;const env=environment(),a=createCharacterActor(options({...env,id:'a',onChange:()=>changes++})),b=createCharacterActor(options({...env,id:'b'}));try{
  a.rig.setEditor({rigLayers:{bones:true,joints:true,face:true}});b.rig.setEditor({rigLayers:{bones:true,joints:true,face:true}});
  assert.equal(changes,0);const selected=a.rig.values().name;a.setActive(false);a.rig.select(0);assert.equal(a.rig.values().name,selected);a.rig.projectHelpers();assert.equal(a.rig.metrics().display.joints,0);assert.equal(a.rig.metrics().display.controller,false);
  b.rig.projectHelpers();assert.ok(b.rig.metrics().display.joints>0);
  a.setActive(true);a.setVisible(false);assert.equal(a.root.visible,false);assert.equal(a.rig.metrics().display.controller,false);a.setVisible(true);
  const before=a.snapshotHelpers();a.hideHelpers();a.hideHelpers();a.restoreHelpers(before);a.restoreHelpers(before);a.rig.projectHelpers();assert.ok(a.rig.metrics().display.joints>0);
  assert.equal(changes,0,'activation/helper changes are not model changes');
 }finally{disposeAll(a,b);}
});
test('dispose is idempotent, releases own skeleton/meshes/materials/helpers only, and retains shared texture',()=>{
 const env=environment(),texture=new THREE.Texture(),a=createCharacterActor(options({...env,id:'a',eyeTexture:texture})),b=createCharacterActor(options({...env,id:'b',eyeTexture:texture}));
 const counters={texture:0,skeleton:0},geometries=[a.body,a.eyes,...a.parts.map(p=>p.mesh)].map(m=>m.geometry),materials=new Set([a.material,a.eyes.material,...a.parts.map(p=>p.mesh.material)]),counts=new Map();
 texture.addEventListener('dispose',()=>counters.texture++);const original=a.body.skeleton.dispose.bind(a.body.skeleton);a.body.skeleton.dispose=()=>{counters.skeleton++;original();};
 for(const object of [...geometries,...materials]){counts.set(object,0);object.addEventListener('dispose',()=>counts.set(object,counts.get(object)+1));}
 try{
  a.dispose();a.dispose();assert.equal(counters.skeleton,1);assert.equal(counters.texture,0);assert.ok([...counts.values()].every(n=>n===1));assert.equal(a.root.parent,null);assert.equal(a.root.children.length,0);assert.equal(a.metrics().disposed,true);assert.throws(()=>a.update(),/disposed/);
  assert.equal(env.scene.children.filter(o=>o.name==='RigDisplayLayers').length,1);assert.equal(b.root.parent,env.scene);b.state.sex=1;b.update();assert.ok(vertices(b.body).every(Number.isFinite));
 }finally{disposeAll(a,b);texture.dispose();}
});
test('identity placement reproduces legacy geometry, facial contact and material settings without extra model transforms',()=>{
 const state={...defaults(),sex:.35,expressions:{eye_close_l:.8},pose:{head:[.1,.1,0],jaw:[.04,0,0]},material:'skin',skin:'#aa8877'},actor=createCharacterActor(options({state})),env=environment(),owned=[];
 function make(source,mat){const g=new THREE.BufferGeometry(),out=Float32Array.from(source.positions),male=source.male||source.positions;for(let i=0;i<out.length;i++)out[i]=source.positions[i]+(male[i]-source.positions[i])*state.sex;for(const morph of source.morphs||[]){const weight=state.expressions[morph.id]??state.morphs[morph.id]??0;if(weight)blendMorph(out,morph,weight,state.sex);}g.setAttribute('position',new THREE.Float32BufferAttribute(out,3));g.setIndex(source.indices);if(source.uv)g.setAttribute('uv',new THREE.Float32BufferAttribute(source.uv,2));g.computeVertexNormals();g.computeBoundingBox();g.computeBoundingSphere();const mesh=new THREE.Mesh(g,mat);owned.push(mesh);env.scene.add(mesh);return mesh;}
 const legacyBody=make(data,new THREE.MeshStandardMaterial({color:state.skin,roughness:.63,metalness:0})),legacyEyes=make(data.eyes,new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.4,alphaTest:.03})),parts=partsData.map(source=>({source,mesh:make(source,new THREE.MeshStandardMaterial())})),legacy=attachRig(legacyBody,legacyEyes,data,rigData,env.scene,env.camera,env.canvas,env.orbit,()=>{},parts);
 try{
  legacy.bind(structuredClone(state));attachFaceContact({body:legacy.body,eyes:legacy.eyes,rig:rigData,definition:contactDefinition}).apply(state);
  close(vertices(actor.body),vertices(legacy.body),0);close(vertices(actor.eyes),vertices(legacy.eyes),0);actor.parts.forEach((p,i)=>close(vertices(p.mesh),vertices(legacy.parts[i]),0));assert.equal(actor.material.color.getHex(),legacyBody.material.color.getHex());assert.equal(actor.material.roughness,legacyBody.material.roughness);assert.equal(actor.material.metalness,0);assert.equal(actor.eyes.material.alphaTest,.03);
 }finally{actor.dispose();legacy.dispose();for(const mesh of owned){mesh.geometry.dispose();mesh.material.dispose();}}
});
test('full state replacement retains editor state reference, clears stale IK and contact correction never accumulates',()=>{
 const actor=createCharacterActor(options());try{
  const reference=actor.state;actor.rig.setLimbMode('arm.L','ik');const replacement={...defaults(),sex:1};actor.update(replacement);assert.equal(actor.state,reference);assert.notEqual(actor.state,replacement);assert.equal(Object.hasOwn(actor.state,'kinematics'),false);
  const baseline=vertices(actor.body);for(let i=0;i<5;i++)actor.update();close(vertices(actor.body),baseline,0);assert.ok(actor.contact.metrics().correctedVertices>0);
 }finally{actor.dispose();}
});
test('bad topology fails without registering partial actor objects in the scene',()=>{
 const opt=options(),before=opt.scene.children.slice();assert.throws(()=>createCharacterActor({...opt,contactDefinition:null,data:{positions:[0,0,0],indices:[4,0,0]}}),/geometry/);assert.deepEqual(opt.scene.children,before);
});
test('disposing one actor removes only its control listeners and preserves the surviving canvas interaction policy',()=>{
 const env=environment(),listeners=new Map(),add=env.canvas.addEventListener.bind(env.canvas),remove=env.canvas.removeEventListener.bind(env.canvas);
 env.canvas.addEventListener=(type,fn,...args)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);add(type,fn,...args);};
 env.canvas.removeEventListener=(type,fn,...args)=>{listeners.get(type)?.delete(fn);remove(type,fn,...args);};
 env.canvas.style.touchAction='pan-y';const a=createCharacterActor(options({...env,id:'a'})),b=createCharacterActor(options({...env,id:'b'}));
 try{
  for(const type of ['pointerdown','pointermove','pointerup'])assert.equal(listeners.get(type).size,2);
  a.dispose();a.dispose();for(const type of ['pointerdown','pointermove','pointerup'])assert.equal(listeners.get(type).size,1);
  assert.equal(env.canvas.style.touchAction,'none');
  b.dispose();for(const set of listeners.values())assert.equal(set.size,0);assert.equal(env.canvas.style.touchAction,'pan-y');
 }finally{disposeAll(a,b);}
});
