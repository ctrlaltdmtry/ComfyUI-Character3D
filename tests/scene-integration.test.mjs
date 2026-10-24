// CPU integration only: real authored meshes/rigs and native EventTarget;
// no browser launch, WebGL renderer, fake PNG or pixel-verification claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSceneController,activeProxy} from '../scene-controller.js';
import {attachSceneUI} from '../scene-controls.js';
import {attachSectionUI} from '../section-controls.js';
import {SECTION_IDS} from '../web/section-state.js';
import {defaults,stableState} from '../web/state.js';
import * as THREE from '../vendor/three.module.js';
await import('./register-three-alias.mjs');
const {createCharacterActor}=await import('../character-actor.js');
const {connectIdentity}=await import('../identity-morphs.js');
const source=fs.readFileSync(new URL('../viewer.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const load=name=>JSON.parse(fs.readFileSync(new URL('../assets/'+name,import.meta.url),'utf8'));
const data=load('human.json'),rigData=load('face-rig.json'),face=load('face-morphs.json'),partsData=load('face-parts.json').parts,contactDefinition=load('face-contact.json');
data.morphs.push(...face.morphs);connectIdentity(load('identity.json'),data,rigData,partsData.map(source=>({source})));
function fixture(){
 const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-20,20,20,-20,.01,1000),canvas=new EventTarget(),orbit={enabled:true};
 canvas.style={};canvas.ownerDocument={pointerLockElement:null};const eyeTexture=new THREE.Texture();
 const controller=createSceneController({createActor:record=>createCharacterActor({id:record.id,state:record.state,data,rigData,partsData,contactDefinition,eyeTexture,scene,camera,canvas,orbit})});
 return {scene,camera,canvas,orbit,eyeTexture,controller,dispose(){controller.dispose();eyeTexture.dispose();}};
}
function vertices(mesh,world=false){const v=new THREE.Vector3(),out=[];mesh.updateWorldMatrix(true,false);for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,v);if(world)v.applyMatrix4(mesh.matrixWorld);out.push(v.x,v.y,v.z);}return out;}
function close(a,b,epsilon=1e-5){assert.equal(a.length,b.length);let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));assert.ok(max<=epsilon,'max error '+max);}

test('production viewer loads sources once, mounts Scene separately and uses runtime-owned state',()=>{
 assert.match(html,/<aside><section id="scene-panel"><\/section>/);assert.match(html,/href="\.\/scene-controls\.css"/);
 assert.equal((source.match(/new THREE\.TextureLoader/g)||[]).length,1);
 for(const file of ['human.json','identity.json','face-rig.json','face-parts.json','face-contact.json'])assert.equal(source.split("'./assets/"+file+"'").length-1,1,file);
 assert.match(source,/sceneUI=attachSceneUI\(\{container:\$\('scene-panel'\),api:window\.character3D\.scene\}/);
 assert.match(source,/\['scene','Сцена'\]/);assert.ok(source.indexOf('sectionUI=attachSectionUI')>source.indexOf('if(hasFaceRig)faceUI=attachFaceUI'));
 assert.match(source,/state=sceneController\.state/);assert.doesNotMatch(source,/rigController\.bind\(state\)/);
 assert.match(source,/body:bodyProxy/);assert.match(source,/rig:rigController/);
});
test('face and shape overlays follow selected effective actor visibility, camera/body selection stay independent',()=>{
 assert.match(source,/const isActorToolHidden=\(\)=>isSheetView\(\)\|\|!activeActor\?\.root\.visible/);
 assert.match(source,/attachIdentityMarkers\(\{.+isSheetView:isActorToolHidden/);
 assert.match(source,/attachFaceUI\(\{.+isSheetView:isActorToolHidden/);
 assert.match(source,/controls\.enabled=!isSheetView\(\)/);
});
test('all public QA methods and historical selected-geometry APIs remain wired',()=>{
 for(const name of ['getActorGeometry','getActorMetrics','getActorBounds','getActorProjection','getGeometry','getPosedGeometry','getRigGeometry','getEyeGeometry','getPartGeometry','getSourceGeometry','getSourcePosedGeometry','getEditorState','setEditorState','exportPNG'])assert.match(source,new RegExp('\\b'+name+'\\b'));
 for(const name of ['getMode','getActors','getSelected','setMode','selectActor','addActor','duplicateActor','removeActor','renameActor','setVisible','setPlacement','resetPlacement','fit'])assert.ok(source.includes("'"+name+"'"));
 assert.match(source,/window\.character3D\.scene=sceneAPI/);assert.match(source,/if\(world\)v\.applyMatrix4\(mesh\.matrixWorld\)/);
 assert.match(source,/getActorMetrics\(id\)\{return findActor\(id\)\?\.metrics\(\)\|\|null/);
 assert.match(source,/getPosedGeometry:\(\)=>posedGeometry\(body\)/);
});
test('replacement/project metadata, all-actor helper export, composition bounds and cleanup are connected',()=>{
 assert.match(source,/return sceneController\.serialize\(cameraController\.renderState\(\)\)/);
 assert.ok(source.indexOf('sceneController.selectActor(editor.selectedActor)')<source.indexOf('rigController.setEditor(editor)'));
 assert.match(source,/normalizeEditorState\(input\.editorState\)/);assert.match(source,/editor\?\.selectedActor/);
 assert.match(source,/for\(const actor of sceneController\.allActors\(\)\).*actor\.snapshotHelpers\(\)/);
 assert.match(source,/finally\{for\(const \[actor,snapshot\]of helpers\)actor\.restoreHelpers\(snapshot\)/);
 assert.match(source,/sceneController\?\.visibleActors\(\)/);assert.match(source,/bodyBounds\.union\(b\.bodyBounds\);faceBounds\.union\(b\.faceBounds\)/);
 for(const expression of ['sceneController?.dispose()','eyeTexture?.dispose()','resizeObserver.disconnect()','disposePicking()','renderer.forceContextLoss()','cameraController.dispose()'])assert.ok(source.includes(expression));
 assert.match(source,/requestAnimationFrame\(render\)/);assert.doesNotMatch(source,/setAnimationLoop|requestAnimationFrame\(draw\)/);
 const faceSource=fs.readFileSync(new URL('../face-controller.js',import.meta.url),'utf8');
 assert.match(faceSource,/function project\(\).*const head=rig\.bones\.find/);assert.doesNotMatch(faceSource,/\n const head=rig\.bones\.find/);
});
test('viewer module graph is readable at its backend editor/package mount; Three resolves through the import map',()=>{
 const mount=new URL('http://qa.invalid/character3d/editor/'),done=new Set();
 function visit(local,served){if(done.has(local.href))return;done.add(local.href);const text=fs.readFileSync(local,'utf8');for(const item of text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){
  const spec=item[1];if(spec==='three'){assert.match(html,/"three":"\.\/vendor\/three\.module\.js"/);continue;}if(!spec.startsWith('.'))continue;
  const next=new URL(spec,served);assert.ok(next.pathname.startsWith(mount.pathname),`${spec} escapes editor mount`);visit(new URL(spec,local),next);
 }}
 visit(new URL('../viewer.js',import.meta.url),new URL('viewer.js',mount));assert.ok(done.size>20);assert.ok([...done].some(url=>url.endsWith('/scene-controller.js')));
});
test('real runtime state facade edits only selected appearance and binds independent geometry/rig/contact',()=>{
 const f=fixture(),c=f.controller;try{
  const first=c.runtime(),firstBody=vertices(first.body),firstEyes=vertices(first.eyes),firstParts=first.parts.map(p=>vertices(p.mesh));
  const id=c.addActor(),second=c.runtime(),rig=activeProxy(()=>c.runtime().rig);
  assert.notEqual(first.state,second.state);assert.notEqual(first.body.geometry,second.body.geometry);assert.notEqual(first.body.skeleton,second.body.skeleton);
  assert.equal(first.eyes.material.map,f.eyeTexture);assert.equal(second.eyes.material.map,f.eyeTexture);
  c.state.sex=1;c.state.morphs.identity_head_width=.4;c.state.expressions.smile_l=.5;c.state.material='skin';c.state.skin='#123456';second.update();rig.preset('portrait');
  assert.equal(c.getSelected(),id);assert.notDeepEqual(vertices(second.body),firstBody);close(vertices(first.body),firstBody,0);close(vertices(first.eyes),firstEyes,0);first.parts.forEach((p,i)=>close(vertices(p.mesh),firstParts[i],0));
  assert.equal(first.material.color.getHexString(),'c9b9a7');assert.equal(second.material.color.getHexString(),'123456');
  const before=stableState(c.serialize());c.selectActor(first.id);assert.equal(stableState(c.serialize()),before);assert.equal(rig.bones,first.rig.bones);
 }finally{f.dispose();}
});
test('real duplicate preserves independent posed anatomy and placement transforms actual world geometry exactly once',()=>{
 const f=fixture(),c=f.controller;try{
  c.state.sex=.3;c.state.pose.head=[.1,.15,0];c.state.pose.jaw=[.08,0,0];c.runtime().update();const local=vertices(c.runtime().body),first=c.runtime();
  const id=c.duplicateActor(),second=c.runtime();close(vertices(second.body),local,1e-6);
  c.setPlacement({position:[9,2,-4],rotation:[.1,.4,-.1]});const expected=[],v=new THREE.Vector3();for(let i=0;i<local.length;i+=3)v.fromArray(local,i).applyMatrix4(second.root.matrixWorld).toArray(expected,i);
  close(vertices(second.body,true),expected);close(vertices(first.body),local,0);assert.equal(c.getActors().find(a=>a.id===id).rotation[1],.4);
  const world=vertices(second.body,true);second.update();close(vertices(second.body,true),world);
 }finally{f.dispose();}
});
test('real scene round-trip restores all actors and editor selection, surviving actor is valid after deletion',()=>{
 const f=fixture(),c=f.controller;try{
  const first=c.runtime();c.state.sex=.5;c.runtime().update();const id=c.addActor();c.state.sex=1;c.runtime().update();c.setPlacement({position:[7,1,2],rotation:[0,.3,0]});
  const before=new Map(c.allActors().map(a=>[a.id,vertices(a.body,true)])),saved=c.serialize();c.replace(saved,first.id);
  assert.equal(first.metrics().disposed,true);assert.equal(c.getSelected(),first.id);for(const actor of c.allActors())close(vertices(actor.body,true),before.get(actor.id));
  const survivor=c.runtime(id);c.removeActor(first.id);assert.equal(c.runtime(),survivor);assert.equal(survivor.metrics().disposed,false);survivor.update();assert.ok(vertices(survivor.body).every(Number.isFinite));
 }finally{f.dispose();}
});
test('production body picker raycasts real visible meshes, handles short clicks and suppresses a stale joint click',()=>{
 const f=fixture(),c=f.controller,pointerCanvas=new EventTarget();try{
  pointerCanvas.getBoundingClientRect=()=>({left:0,top:0,width:800,height:800});const id=c.addActor();c.selectActor('actor-1');
  f.camera.position.set(3,8,80);f.camera.lookAt(3,8,0);f.camera.updateProjectionMatrix();f.camera.updateMatrixWorld(true);
  const pickerSource=source.slice(source.indexOf('function attachActorPicking(){'),source.indexOf('function posedGeometry('));
  const mount=new Function('THREE','renderer','sceneController','camera','scene','isSheetView','ready','exporting',pickerSource+';return attachActorPicking();');
  const remove=mount(THREE,{domElement:pointerCanvas},c,f.camera,f.scene,()=>false,true,false);let staleClicks=0;pointerCanvas.addEventListener('pointerup',()=>staleClicks++,{capture:true});
  const p=c.runtime(id).bounds().bodyBounds.getCenter(new THREE.Vector3()).project(f.camera),x=(p.x*.5+.5)*800,y=(-p.y*.5+.5)*800;
  const send=(type,px=x,py=y)=>{const e=new Event(type);Object.assign(e,{button:0,isPrimary:true,pointerId:1,clientX:px,clientY:py,getCoalescedEvents:()=>[]});pointerCanvas.dispatchEvent(e);};
  send('pointerdown');send('pointerup');assert.equal(c.getSelected(),id);assert.equal(staleClicks,0);
  c.selectActor('actor-1');send('pointerdown');send('pointermove',x+12,y);send('pointermove',x,y);send('pointerup');assert.equal(c.getSelected(),'actor-1');
  c.setVisible(false,id);send('pointerdown');send('pointerup');assert.equal(c.getSelected(),'actor-1');remove();
 }finally{f.dispose();}
});

// Narrow CPU DOM sufficient for the production Scene and section chooser.
class Element {
 constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.parentNode=null;this.attributes=new Map();this.handlers=new Map();this.dataset={};this.classes=new Set();this.value='';this.checked=false;this.disabled=false;this._text='';this.classList={toggle:(key,on)=>on?this.classes.add(key):this.classes.delete(key)};}
 set id(value){this.setAttribute('id',value);}get id(){return this.getAttribute('id')||'';}set className(value){this.classes=new Set(value.split(/\s+/));}
 set textContent(value){this._text=String(value);this.replaceChildren();}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 get firstChild(){return this.children[0]||null;}append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
 insertBefore(node,target){node.remove();node.parentNode=this;const i=this.children.indexOf(target);this.children.splice(i<0?this.children.length:i,0,node);}
 replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this.append(...nodes);}
 remove(){if(this.parentNode){this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;}}
 setAttribute(key,value){this.attributes.set(key,String(value));}getAttribute(key){return this.attributes.get(key)??null;}removeAttribute(key){this.attributes.delete(key);}
 addEventListener(type,fn){if(!this.handlers.has(type))this.handlers.set(type,new Set());this.handlers.get(type).add(fn);}removeEventListener(type,fn){this.handlers.get(type)?.delete(fn);}
 dispatch(type,extra={}){for(const fn of this.handlers.get(type)||[])fn({target:this,...extra});}click(extra){if(!this.disabled)this.dispatch('click',extra);}
}
class Document {
 constructor(){this.body=new Element('body',this);}createElement(tag){return new Element(tag,this);}createElementNS(_ns,tag){return this.createElement(tag);}
 getElementById(id){function visit(node){if(node.id===id)return node;for(const child of node.children){const found=visit(child);if(found)return found;}return null;}return visit(this.body);}
}
test('real Scene API + section chooser mounts eleven tiles; ordinary/Shift/open-all/close-all retain semantics',()=>{
 const f=fixture(),c=f.controller,doc=new Document(),aside=doc.createElement('aside');doc.body.append(aside);
 const sections=SECTION_IDS.map(id=>{const element=doc.createElement('section');element.id=id+'-panel';aside.append(element);return {id,label:id,element};});
 const sceneUI=attachSceneUI({container:doc.getElementById('scene-panel'),api:c}),chooser=attachSectionUI({container:aside,sections});
 const $=id=>{const node=doc.getElementById(id);assert.ok(node,id);return node;};
 try{
  assert.equal($('section-navigation').children[1].children.length,11);$('section-tile-scene').click();assert.deepEqual(chooser.metadata().openSections,['scene']);
  $('scene-add').click();assert.equal(c.getActors().length,2);assert.equal($('scene-actors').value,c.getSelected());
  $('section-tile-pose').click({shiftKey:true});assert.deepEqual(chooser.metadata().openSections,['scene','pose']);
  $('section-tile-camera').click();assert.deepEqual(chooser.metadata().openSections,['camera']);$('sections-open-all').click();assert.deepEqual(chooser.metadata().openSections,SECTION_IDS);
  $('sections-close-all').click();assert.deepEqual(chooser.metadata().openSections,[]);
  for(const id of ['scene-add','scene-name','scene-position-x','scene-rotation-y','scene-fit']){let node=$(id);while(node&&node.id!=='scene-panel')node=node.parentNode;assert.equal(node,$('scene-panel'));}
 }finally{chooser.dispose();sceneUI.dispose();f.dispose();}
});
