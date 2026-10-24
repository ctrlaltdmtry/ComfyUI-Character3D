import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {createCharacterActor} from './character-actor.js';
import {createSceneController,activeProxy} from './scene-controller.js';
import {attachSceneUI} from './scene-controls.js';
import {SCENE_SCHEMA,characterState} from './web/scene-state.js';
import {attachFaceUI} from './face-controller.js';
import {connectEditor} from './editor-bridge.js';
import {clampMorph,connectIdentity} from './identity-morphs.js';
import {attachIdentityUI} from './identity-controls.js';
import {attachIdentityMarkers} from './identity-markers.js';
import {createCameraController} from './camera-controller.js';
import {attachRenderUI} from './render-controls.js';
import {resolveCanvas,validateCanvas} from './web/render-settings.js';
import {defaults,normalizeState,normalizeEditorState} from './web/state.js';
import {attachJointPicker} from './joint-interaction.js';
import {attachRigUI} from './rig-controls.js';
import {attachKinematicUI} from './kinematic-controls.js';
import {validateKinematics} from './web/kinematic-state.js';
import {validateSheet,validateSheetCamera} from './web/sheet-state.js';
import {layoutSheet} from './sheet-layout.js';
import {attachSheetUI} from './sheet-controls.js';
import {attachSectionUI} from './section-controls.js';
import {renderSheet,sheetCameraDescriptor,composeSheetPNG} from './sheet-renderer.js';
import {t,getLanguage,setLanguage,onLanguageChange,bindText,bindAttr,localizeDOM} from './i18n.js';
const $=id=>document.getElementById(id);
// Explicit local failures may cross the bridge; renderer/transport errors may not.
const localError=source=>Object.assign(Error(source),{i18nSource:source});
// This presentation adapter deliberately knows nothing about render/editor state.
export function attachEditorLanguageUI(doc=document){
 const bindings=[localizeDOM(doc)],sources=new Map(),owners=new Map(),select=doc.getElementById('ui-language');
 let disposed=false;
 const value=v=>typeof v==='function'?v():v;
 function text(id,source,params={}){if(disposed)return;if(owners.has(id)){owners.get(id)?.(value(source),value(params));return;}const node=doc.getElementById(id);let record=sources.get(id);if(record){record.source=source;record.params=params;node.textContent=t(value(source),value(params));}else{record={source,params};record.off=bindText(node,()=>value(record.source),()=>value(record.params));sources.set(id,record);}}
 for(const id of ['load','status','view-label'])text(id,doc.getElementById(id).textContent);
 select.value=getLanguage();const change=()=>setLanguage(select.value);
 // Contain this native select before document-level graph/rig shortcuts.
 const keyHost=doc.defaultView||select,captureKeys=keyHost!==select;
 const containKey=event=>{if(event.target===select||event.composedPath?.().includes(select))event.stopPropagation();};
 keyHost.addEventListener('keydown',containKey,captureKeys);keyHost.addEventListener('keyup',containKey,captureKeys);
 select.addEventListener('change',change);const unsubscribe=onLanguageChange(next=>{select.value=next;});
 // Seed the idle successor from canonical source+params, not localized DOM text.
 // A transferred leaf never reacquires a viewer binding: every later write goes to its owner.
 return {text,release(id,write){const record=sources.get(id);record?.off();sources.delete(id);owners.set(id,write);if(!disposed&&record)write?.(value(record.source),value(record.params));},bind(node,source,params={}){if(!disposed)bindings.push(bindText(node,source,params));},attr(node,key,source,params={}){if(!disposed)bindings.push(bindAttr(node,key,source,params));},dispose(){if(disposed)return;disposed=true;unsubscribe();keyHost.removeEventListener('keydown',containKey,captureKeys);keyHost.removeEventListener('keyup',containKey,captureKeys);select.removeEventListener('change',change);bindings.forEach(off=>off());sources.forEach(record=>record.off());sources.clear();owners.clear();}};
}
const editorLanguage=attachEditorLanguageUI();
let sceneController,sceneUI,activeActor,eyeTexture,rigData,partsData=[],contactDefinition=null;
// Keep legacy initial optional-field omission (including its saved hashes).
let state={schema:'character-3d-preview/1',sex:0,morphs:{},pose:{},expressions:{},faceOffsets:{},faceSymmetry:true,view:'portrait',material:'clay',skin:'#b98570',free:false,alpha:false};
const rigController=activeProxy(()=>activeActor?.rig);
const bodyProxy=activeProxy(()=>activeActor?.body);
let faceContact,faceUI,identityUI,identityMarkers,identityCount=0,faceMorphData={morphs:[]},partMeshes=[];
let data,body,eyes,frame=0,frames=0,updateMs=0,loadBytes=0,ready=false,exporting=false;
const bg=new THREE.Color('#333e4a'),scene=new THREE.Scene();scene.background=bg;
const camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,1000);
const sheetFace=camera.clone(),sheetBody=camera.clone();
let renderer,controls,cameraController,renderUI,jointPicker,rigUI,kinematicUI,sheetUI,sheetLabels,sectionUI;
try{renderer=new THREE.WebGLRenderer({canvas:$('canvas'),antialias:true,alpha:true,powerPreference:'low-power'});}catch(e){editorLanguage.text('load','WebGL2 недоступен. Нужен браузер с включённым аппаратным ускорением.');throw e;}
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;
renderer.info.autoReset=false;
controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;
cameraController=createCameraController({camera,controls,viewport:()=>({width:$('viewport').clientWidth,height:$('viewport').clientHeight}),output:()=>resolveCanvas(state),changed:kind=>{if(ready&&!exporting){renderUI?.sync();sheetUI?.sync();controls.enabled=!isSheetView();rigController?.viewChanged?.();invalidate(kind==='render');}}});
const isSheetView=()=>state.view==='sheet'&&cameraController.mode();
// Marker adapters follow the selected actor's effective visibility, not only sheet mode.
const isActorToolHidden=()=>isSheetView()||!activeActor?.root.visible;
scene.add(new THREE.HemisphereLight('#dce8ff','#554a43',2.2));
const key=new THREE.DirectionalLight('#fff0df',3.1);key.position.set(-8,12,12);scene.add(key);
const fill=new THREE.DirectionalLight('#b3d0fa',1.35);fill.position.set(9,5,6);scene.add(fill);
const rim=new THREE.DirectionalLight('#e3eeff',2.4);rim.position.set(5,10,-9);scene.add(rim);
const bounds=new THREE.Box3(),center=new THREE.Vector3(),size=new THREE.Vector3();
function compositionBounds(){
 const bodyBounds=new THREE.Box3(),faceBounds=new THREE.Box3();
 for(const actor of sceneController?.visibleActors()||[]){const b=actor.bounds();bodyBounds.union(b.bodyBounds);faceBounds.union(b.faceBounds);}
 // An entirely hidden multi-scene is a valid empty render. Retain a stable
 // framing fallback rather than introducing infinities into camera descriptors.
 if(bodyBounds.isEmpty()&&activeActor){const b=activeActor.bounds();bodyBounds.copy(b.bodyBounds);faceBounds.copy(b.faceBounds);}
 return {bodyBounds,faceBounds};
}
function refreshBounds(){const b=compositionBounds();bounds.copy(b.bodyBounds);bounds.getCenter(center);bounds.getSize(size);return b;}
function selectRuntime(actor){
 activeActor=actor;body=actor.body;eyes=actor.eyes;partMeshes=actor.parts;faceContact=actor.contact;
 if(!ready)return;
 $('skin').value=state.skin;$('alpha').checked=state.alpha;controlsUI();rigUI?.sync();faceUI?.sync();
 if($('joint'))$('joint').value=actor.rig.bones.findIndex(b=>b.name===actor.rig.values().name);
 poseUI();identityMarkers?.project();rigUI?.hover(null);
}
function syncScene(kind){
 if(!ready)return;
 scene.background=state.alpha?null:new THREE.Color(resolveCanvas(state).background);sceneUI?.sync();
 controlsUI();cameraController.resized();renderUI?.sync();sheetUI?.sync();controls.enabled=!isSheetView();
 rigController.viewChanged();invalidate(kind!=='editor');
}
function updateModel(reframe=false){
 if(exporting)return;const start=performance.now();activeActor.update();updateMs=performance.now()-start;
 if(reframe)front();faceUI?.sync();invalidate();
}
function setupCamera(cam,view,aspect){
 const composition=refreshBounds(),portrait=view==='portrait';
 if(sceneController.isScene()){
  const box=portrait?composition.faceBounds:composition.bodyBounds,target=box.getCenter(new THREE.Vector3()),extent=box.getSize(new THREE.Vector3());
  const height=Math.max(extent.y,extent.x/aspect,.001)*(portrait?1.18:1.12),distance=Math.max(composition.bodyBounds.getSize(new THREE.Vector3()).length(),height,1)*3;
  cam.left=-height*aspect/2;cam.right=height*aspect/2;cam.top=height/2;cam.bottom=-height/2;cam.near=.001;cam.far=distance*3;cam.zoom=1;
  cam.position.copy(target).add(new THREE.Vector3(0,0,distance));cam.up.set(0,1,0);cam.lookAt(target);cam.updateProjectionMatrix();return target;
 }
 // Keep the historical single-character neutral framing until scene opt-in.
 bounds.copy(body.geometry.boundingBox);bounds.getCenter(center);bounds.getSize(size);
 const h=size.y,target=new THREE.Vector3(center.x,portrait?bounds.max.y-h*.085:center.y,center.z);
 const height=portrait?h*.245:Math.max(h*1.12,size.x/aspect*1.12);
 cam.left=-height*aspect/2;cam.right=height*aspect/2;cam.top=height/2;cam.bottom=-height/2;cam.near=h*.001;cam.far=h*20;cam.zoom=1;
 cam.position.set(target.x,target.y,bounds.max.z+h*2.5);cam.up.set(0,1,0);cam.lookAt(target);cam.updateProjectionMatrix();return target;
}
function front(){
 const inCamera=renderUI?cameraController.mode():true;
 if(inCamera&&state.view==='sheet'&&state.sheet){const index=selectedSheetCell(),candidate=validateSheet({...state.sheet,cells:state.sheet.cells.map((c,i)=>i===index?{...c,preset:'front',camera:null}:c)});state.sheet=candidate;sheetUI?.sync();invalidate();return;}
 const canvasSize=inCamera?resolveCanvas(state):{width:$('viewport').clientWidth,height:$('viewport').clientHeight},temp=camera.clone(),target=setupCamera(temp,state.view==='body'?'body':'portrait',canvasSize.width/canvasSize.height);
 const view={position:temp.position.toArray(),target:target.toArray(),zoom:temp.zoom,height:temp.top-temp.bottom,...(sceneController.isScene()?{near:temp.near,far:temp.far,up:temp.up.toArray()}:{})};
 if(!renderUI)cameraController.initialize(view);else cameraController.setActive(view);
 controls.enabled=!isSheetView();editorLanguage.text('view-label',isSheetView()?'Портрет + фигура · анфас':cameraController.mode()?'Камера кадра':'Свободный рабочий вид');renderUI?.sync();invalidate(cameraController.mode());
}
function draw(width,height,output=false){
 for(const actor of sceneController?.allActors()||[])actor.rig.projectHelpers();
 renderer.info.reset();renderer.setScissorTest(false);renderer.setViewport(0,0,width,height);renderer.clear();
 if(state.view==='sheet'&&state.sheet&&(output||cameraController.mode())){
  const c=resolveCanvas(state);renderSheet({renderer,scene,sheet:state.sheet,outputWidth:c.width,outputHeight:c.height,width,height,frame:output?{x:0,y:0,width,height}:cameraController.frame(),bounds:compositionBounds()});
 }else if(state.view==='sheet'&&(output||cameraController.mode())){
  const r=output?{x:0,y:0,width,height}:cameraController.frame(),half=Math.floor(r.width*.51),bottom=height-r.y-r.height;
  setupCamera(sheetFace,'portrait',half/r.height);setupCamera(sheetBody,'body',(r.width-half)/r.height);
  renderer.setScissorTest(true);renderer.setScissor(r.x,bottom,half,r.height);renderer.setViewport(r.x,bottom,half,r.height);renderer.render(scene,sheetFace);
  renderer.setScissor(r.x+half,bottom,r.width-half,r.height);renderer.setViewport(r.x+half,bottom,r.width-half,r.height);renderer.render(scene,sheetBody);renderer.setScissorTest(false);
 }else renderer.render(scene,output?cameraController.outputCamera():camera);
 projectSheetLabels(output);faceUI?.project();identityMarkers?.project();jointPicker?.project();kinematicUI?.project();frames++;const triangles=renderer.info.render.triangles,ms=updateMs.toFixed(1);editorLanguage.text('perf','{triangles} трис / кадр · {ms} ms форма',()=>({triangles:triangles.toLocaleString(getLanguage()==='en'?'en-US':'ru-RU'),ms}));
}
function selectedSheetCell(index=sheetUI?.selectedIndex()??0){
 if(!state.sheet||!Number.isInteger(index)||index<0||index>=state.sheet.cells.length)throw Error('Сначала выбери ячейку листа.');return index;
}
function getSheetCellCamera(index){index=selectedSheetCell(index);const c=resolveCanvas(state),r=layoutSheet(state.sheet,c.width,c.height)[index];return sheetCameraDescriptor(state.sheet.cells[index],r.image.width/r.image.height,compositionBounds());}
function inspectSheetCell(index){
 const view=getSheetCellCamera(index),editor=cameraController.editorState();cameraController.setEditor({...editor,cameraMode:false,viewport:view});renderUI?.sync();rigController?.viewChanged?.();controls.enabled=true;invalidate(false);
}
function captureSheetCell(index){
 index=selectedSheetCell(index);if(cameraController.mode())throw Error('Перейди в навигацию и настрой ракурс перед сохранением в ячейку.');
 const nav=cameraController.editorState().viewport,view=validateSheetCamera({...nav,near:nav.near??camera.near,far:nav.far??camera.far,up:nav.up??camera.up.toArray()}),candidate=validateSheet({...state.sheet,cells:state.sheet.cells.map((cell,i)=>i===index?{...cell,preset:'custom',camera:view}:cell)});const c=resolveCanvas(state);layoutSheet(candidate,c.width,c.height);state.sheet=candidate;sheetUI?.sync();invalidate();
}
function projectSheetLabels(output=false){
 if(!sheetLabels){sheetLabels=document.createElement('div');sheetLabels.className='sheet-label-overlay';sheetLabels.setAttribute('aria-hidden','true');Object.assign(sheetLabels.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden'});$('viewport').append(sheetLabels);}
 const visible=!output&&isSheetView()&&state.sheet?.labels;sheetLabels.hidden=!visible;sheetLabels.replaceChildren();if(!visible)return;
 const c=resolveCanvas(state),f=cameraController.frame();for(const r of layoutSheet(state.sheet,c.width,c.height)){if(!r.label)continue;const text=state.sheet.cells[r.index].label;if(!text)continue;const t=r.label,span=document.createElement('span');span.textContent=text;Object.assign(span.style,{position:'absolute',display:'flex',alignItems:'center',justifyContent:'center',whiteSpace:'nowrap',overflow:'hidden',color:state.sheet.labelColor,font:`500 ${state.sheet.labelSize*f.height/c.height}px sans-serif`,left:(f.x+t.x*f.width/c.width)+'px',top:(f.y+t.y*f.height/c.height)+'px',width:t.width*f.width/c.width+'px',height:t.height*f.height/c.height+'px'});sheetLabels.append(span);}
}
function render(){frame=0;if(!ready||exporting)return;const w=$('viewport').clientWidth,h=$('viewport').clientHeight;renderer.setSize(w,h,false);draw(w,h);}
let changeNotice=false;
function invalidate(renderChanged=true){if(!frame&&!exporting)frame=requestAnimationFrame(render);if(!changeNotice){changeNotice=true;queueMicrotask(()=>{changeNotice=false;if(ready)window.dispatchEvent(new Event('character3d:change'));});}}
const resizeObserver=new ResizeObserver(()=>{if(ready){cameraController.resized();renderUI?.sync();invalidate(false);}});resizeObserver.observe($('viewport'));
function controlsUI(){
 document.querySelectorAll('[data-sex]').forEach(b=>b.classList.toggle('active',Number(b.dataset.sex)===state.sex));
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));
 document.querySelectorAll('[data-material]').forEach(b=>b.classList.toggle('active',b.dataset.material===state.material));
 $('free').classList.toggle('active',state.free);$('natural').classList.toggle('active',!state.free);
 const morphs=data.morphs.filter(m=>!faceMorphData.morphs.some(f=>f.id===m.id));if(!identityUI)identityUI=attachIdentityUI({container:$('morphs'),morphs,state,change:()=>updateModel()});else identityUI.sync();
}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function boneLabel(name){const names={Root:'Корень',pelvis:'Таз',spine_01:'Позвоночник · низ',spine_02:'Позвоночник · середина',spine_03:'Грудной отдел',neck_01:'Шея',head:'Голова',jaw:'Челюсть','eye.L':'Глаз · слева','eye.R':'Глаз · справа',clavicle:'Ключица',upperarm:'Плечо',lowerarm:'Предплечье',hand:'Кисть',thigh:'Бедро',calf:'Голень',foot:'Стопа',ball:'Пальцы стопы',thumb:'Большой палец',index:'Указательный',middle:'Средний',ring:'Безымянный',pinky:'Мизинец'};if(names[name])return t(names[name]);const side=/(?:_l|\.L)$/.test(name)?t(' · слева'):/(?:_r|\.R)$/.test(name)?t(' · справа'):'';const base=name.replace(/(?:_[lr]|\.[LR])$/,'');const parts=base.split('_');return t(names[base]||names[parts[0]]||base)+(parts.length>1?' '+parts[1]:'')+side;}
function initPoseUI(){
 const section=document.createElement('section');section.id='pose-panel';
 section.innerHTML='<h2></h2><label class="row"><span data-i18n="Сустав"></span> <select id="joint"></select></label><div class="seg" style="margin-top:10px"><button id="bone-rotate" class="active" data-i18n="Вращение"></button><button id="bone-translate" data-i18n="Сдвиг лица"></button></div><div id="joint-angles"></div><div class="seg wrap" style="margin-top:14px"><button data-pose="rest" data-i18n="Исходная"></button><button data-pose="relaxed" data-i18n="Руки ниже"></button><button data-pose="portrait" data-i18n="Портрет"></button><button data-pose="contrapposto" data-i18n="Наклон"></button></div><p class="note" data-i18n="Три оси вращения каждого сустава, включая пальцы. Ограничения здесь — пределы углов, не полная анатомическая модель суставов. Свободно: ±180°. Скелет и вращатель не входят в PNG."></p>';
 editorLanguage.bind(section.querySelector('h2'),'Поза · костей: {count}',{count:rigController.bones.length});
 section.querySelectorAll('[data-i18n]').forEach(node=>editorLanguage.bind(node,node.dataset.i18n));
 $('morphs').closest('section').after(section);
 rigController.bones.forEach((b,i)=>{const option=document.createElement('option');option.value=i;editorLanguage.bind(option,()=>boneLabel(b.name));$('joint').append(option);});
 $('joint').value=rigController.bones.findIndex(b=>b.name==='head');
 $('joint').onchange=e=>{rigController.select(Number(e.target.value));poseUI();invalidate();};
 $('bone-rotate').onclick=()=>rigController.setMode('rotate');$('bone-translate').onclick=()=>rigController.setMode('translate');
 for(const axis of ['x','y','z']){const label=document.createElement('label');label.className='slider';label.innerHTML='<span>'+axis.toUpperCase()+' <output id="angle-value-'+axis+'"></output></span><input id="angle-'+axis+'" type="range" step="1">';$('joint-angles').append(label);editorLanguage.attr($('angle-'+axis),'aria-label','Вращение {axis}',{axis:axis.toUpperCase()});$('angle-'+axis).oninput=e=>rigController.rotation(axis,Number(e.target.value));}
 section.querySelectorAll('[data-pose]').forEach(b=>b.onclick=()=>{rigController.preset(b.dataset.pose);poseUI();});poseUI();
}
function poseUI(){kinematicUI?.sync();if(!rigController||!$('joint'))return;const values=rigController.values();$('bone-translate').disabled=!values.facial;faceUI?.sync();['x','y','z'].forEach((axis,i)=>{const input=$('angle-'+axis);if(!input)return;input.min=-values.limits[i];input.max=values.limits[i];input.value=values.rotation[i];$('angle-value-'+axis).textContent=values.rotation[i].toFixed(0)+'°';});}
function getState(){if(!ready)throw Error('Модель ещё не загружена');return sceneController.serialize(cameraController.renderState());}
function getEditorState(){return normalizeEditorState({...cameraController.editorState(),...renderUI?.metadata(),...rigController?.editorState(),...rigUI?.metadata(),...sheetUI?.metadata(),...sectionUI?.metadata(),...(sceneController?.isScene()?{selectedActor:sceneController.getSelected()}:{})});}
function setEditorState(input){
 const editor=normalizeEditorState(input);if(editor.selectedActor!==undefined)sceneController.selectActor(editor.selectedActor);
 // Restore selection before rig metadata: selectedJoint/IK layers belong to it.
 rigController.setEditor(editor);cameraController.setEditor(editor);renderUI?.restore(editor);rigUI?.restore(editor);sheetUI?.restore(editor);sectionUI?.restore(editor);
 controls.enabled=!isSheetView();if($('joint'))$('joint').value=rigController.bones.findIndex(b=>b.name===rigController.values().name);poseUI();rigController.viewChanged();invalidate(false);
}
function validateRenderCamera(value){
 if(!value||typeof value!=='object'||['position','target'].some(key=>!Array.isArray(value[key])||value[key].length!==3||!value[key].every(Number.isFinite))||['zoom','height'].some(key=>!Number.isFinite(value[key])||value[key]<=0)||value.position.every((v,i)=>v===value.target[i]))throw Error('Некорректная камера');
 const near=value.near??.01,far=value.far??1000;if(!Number.isFinite(near)||!Number.isFinite(far)||near<0||far<=near)throw Error('Некорректная глубина камеры');
 if(value.up&&(!Array.isArray(value.up)||value.up.length!==3||!value.up.every(Number.isFinite)||value.up.every(v=>v===0)))throw Error('Некорректный вектор камеры');
}
function refreshStateUI(){
 $('skin').value=state.skin;$('alpha').checked=state.alpha;scene.background=state.alpha?null:new THREE.Color(resolveCanvas(state).background);
 controlsUI();poseUI();cameraController.resized();renderUI?.sync();sheetUI?.sync();sceneUI?.sync();controls.enabled=!isSheetView();rigController.viewChanged();invalidate();
}
function setState(input,editorSelected){
 if(!ready)throw Error('Модель ещё не загружена');if(exporting)throw Error('Дождись завершения экспорта');
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Некорректные параметры');
 if(input.schema){
  if(!['character-3d-preview/1',SCENE_SCHEMA].includes(input.schema))throw Error('Неизвестная схема');
  const validated=normalizeState(input);if(validated.camera)validateRenderCamera(validated.camera);
  sceneController.replace(validated,editorSelected);if(validated.camera)cameraController.setRender(validated.camera);refreshStateUI();return;
 }
 // Historical partial setters accept numeric strings from native controls.
 // Work on a detached draft; invalid canvas/IK/sheet/camera never half-mutate.
 const draft=structuredClone({...state});
 if(Object.hasOwn(input,'canvas'))draft.canvas=validateCanvas(input.canvas);
 if(Object.hasOwn(input,'kinematics'))draft.kinematics=validateKinematics(input.kinematics);
 if(Object.hasOwn(input,'sheet'))draft.sheet=validateSheet(input.sheet);
 if(input.sex!==undefined)draft.sex=Math.max(0,Math.min(1,Number(input.sex)||0));
 if(['portrait','body','sheet'].includes(input.view))draft.view=input.view;
 if(['clay','skin','wire'].includes(input.material))draft.material=input.material;
 if(/^#[0-9a-f]{6}$/i.test(input.skin||''))draft.skin=input.skin;
 for(const key of ['free','alpha','faceSymmetry'])if(typeof input[key]==='boolean')draft[key]=input[key];
 if(input.morphs){for(const m of data.morphs){if(faceMorphData.morphs.some(f=>f.id===m.id))continue;draft.morphs[m.id]=clampMorph(m,Number(input.morphs[m.id]||0),draft.free);}}
 if(input.expressions&&typeof input.expressions==='object'){draft.expressions={};for(const m of faceMorphData.morphs){const v=Number(input.expressions[m.id]||0);draft.expressions[m.id]=Number.isFinite(v)?Math.max(0,Math.min(1,v)):0;}}
 if(typeof input.expressionPreset==='string')draft.expressionPreset=input.expressionPreset;
 if(Number.isFinite(input.expressionStrength))draft.expressionStrength=Math.max(0,Math.min(1,input.expressionStrength));
 if(input.faceOffsets&&typeof input.faceOffsets==='object'){draft.faceOffsets={};for(const [name,v]of Object.entries(input.faceOffsets)){if(Array.isArray(v)&&v.length===3&&v.every(Number.isFinite))draft.faceOffsets[name]=v.map(x=>Math.max(-.25,Math.min(.25,x)));}}
 if(input.pose&&typeof input.pose==='object'){draft.pose={};for(const bone of rigController.bones){const p=input.pose[bone.name];if(Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))draft.pose[bone.name]=p.map(v=>Math.max(-Math.PI,Math.min(Math.PI,v)));}}
 if(input.camera){validateRenderCamera(input.camera);draft.camera=structuredClone(input.camera);}
 const validated=normalizeState(draft);
 activeActor.update(characterState(validated));
 for(const key of ['view','alpha','canvas','sheet','camera'])if(Object.hasOwn(validated,key))state[key]=validated[key];
 updateMs=activeActor.metrics().updateMs;if(input.camera)cameraController.setRender(input.camera);refreshStateUI();
}
async function exportPNG(){
 if(!ready||exporting)throw localError('Модель ещё не готова');exporting=true;if(frame){cancelAnimationFrame(frame);frame=0;}
 const ratio=renderer.getPixelRatio(),helpers=[];
 try{
  cameraController.capture();for(const actor of sceneController.allActors()){const snapshot=actor.snapshotHelpers();helpers.push([actor,snapshot]);actor.hideHelpers();}
  const {width,height,background}=resolveCanvas(state);
  renderer.setPixelRatio(1);renderer.setSize(width,height,false);scene.background=state.alpha?null:new THREE.Color(background);
  draw(width,height,true);const output=state.view==='sheet'&&state.sheet?.labels?composeSheetPNG(renderer.domElement,state.sheet,width,height):renderer.domElement;const blob=await new Promise((resolve,reject)=>output.toBlob(b=>b?resolve(b):reject(localError('PNG не создан')),'image/png'));
  if(blob.size>16*1024*1024)throw localError('PNG превышает 16 MiB. Уменьши холст.');
  return blob;
 }finally{for(const [actor,snapshot]of helpers)actor.restoreHelpers(snapshot);scene.background=state.alpha?null:new THREE.Color(resolveCanvas(state).background);renderer.setPixelRatio(ratio);exporting=false;render();}
}
$('export').onclick=async()=>{try{$('export').disabled=true;const blob=await exportPNG();download(blob,`character-3d-${state.sex?'male':'female'}-${state.view}.png`);editorLanguage.text('status','PNG экспортирован. Включённые подписи листа входят в PNG и маску; служебные элементы — нет.');}catch(e){editorLanguage.text('status',e.message);}finally{$('export').disabled=false;}};
 $('save').onclick=()=>download(new Blob([JSON.stringify({schema:'character-3d-project/1',state:getState(),editorState:getEditorState()},null,2)],{type:'application/json'}),'character-3d.json');
 $('load-state').onclick=()=>$('state-file').click();$('state-file').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>131072)throw Error('Параметры превышают 128 KiB');const input=JSON.parse(await f.text());const project=input.schema==='character-3d-project/1',editor=project&&input.editorState?normalizeEditorState(input.editorState):null;setState(project?input.state:input,editor?.selectedActor);if(editor)setEditorState(editor);editorLanguage.text('status','Параметры, поза и камеры восстановлены.');}catch(err){editorLanguage.text('status',err.message);}finally{e.target.value='';}};
$('front').onclick=()=>ready&&front();$('reset').onclick=()=>{if(!ready||exporting)return;if(sceneController.isScene()){activeActor.update(characterState(defaults()));refreshStateUI();return;}delete state.canvas;delete state.kinematics;delete state.sheet;setState({sex:0,morphs:{},pose:{},expressions:{},faceOffsets:{},faceSymmetry:true,view:'portrait',material:'clay',free:false,alpha:false});cameraController.setMode(true);front();};
$('skin').oninput=e=>{if(ready&&!exporting){state.skin=e.target.value;state.material='skin';controlsUI();updateModel();}};
$('alpha').onchange=e=>{if(!ready||exporting)return;state.alpha=e.target.checked;scene.background=state.alpha?null:new THREE.Color(resolveCanvas(state).background);renderUI?.sync();invalidate();};
$('free').onclick=()=>ready&&setState({free:true});$('natural').onclick=()=>ready&&setState({free:false,morphs:state.morphs});
for(const kind of ['sex','view','material'])document.querySelectorAll(`[data-${kind}]`).forEach(b=>b.onclick=()=>{if(!ready)return;setState({[kind]:b.dataset[kind]});if(kind==='view'){cameraController.setMode(true);front();}});
// Installed before the selected-rig picker, so a body click changing actors
// cannot also select a joint on the previous actor during the same pointerup.
function attachActorPicking(){
 const canvas=renderer.domElement,ray=new THREE.Raycaster();let gesture=null;
 const busy=()=>sceneController.allActors().some(actor=>actor.rig.pointerBusy());
 function down(e){if(!ready||exporting||e.button!==0||e.isPrimary===false||isSheetView()||busy()){gesture=null;return;}gesture={id:e.pointerId,x:e.clientX,y:e.clientY,distance:0};}
 function move(e){if(!gesture||gesture.id!==e.pointerId)return;const samples=e.getCoalescedEvents?.();for(const sample of samples?.length?samples:[e])gesture.distance=Math.max(gesture.distance,Math.hypot(sample.clientX-gesture.x,sample.clientY-gesture.y));}
 function up(e){
  if(!gesture||gesture.id!==e.pointerId)return;const g=gesture;gesture=null;
  if(!ready||exporting||isSheetView()||busy()||g.distance>5||Math.hypot(e.clientX-g.x,e.clientY-g.y)>5)return;
  const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
  camera.updateMatrixWorld(true);scene.updateMatrixWorld(true);ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);
  const meshes=[],owners=new Map();
  for(const actor of sceneController.visibleActors())for(const mesh of [actor.body,actor.eyes,...actor.parts.map(p=>p.mesh)]){
   if(!mesh)continue;mesh.updateWorldMatrix(true,false);
   // SkinnedMesh raycast uses mesh (not geometry) bounds; never reuse neutral
   // bounds after FK/IK or a morph has changed the visible surface.
   if(mesh.isSkinnedMesh){mesh.computeBoundingSphere();mesh.computeBoundingBox();}
   meshes.push(mesh);owners.set(mesh,actor.id);
  }
  const hit=ray.intersectObjects(meshes,false)[0],id=hit&&owners.get(hit.object);
  if(id&&id!==sceneController.getSelected()){sceneController.selectActor(id);e.stopImmediatePropagation();}
 }
 function cancel(){gesture=null;}
 const handlers={pointerdown:down,pointermove:move,pointerup:up,pointercancel:cancel,lostpointercapture:cancel};
 for(const [event,fn]of Object.entries(handlers))canvas.addEventListener(event,fn,{capture:true});
 return ()=>{for(const [event,fn]of Object.entries(handlers))canvas.removeEventListener(event,fn,{capture:true});gesture=null;};
}
function posedGeometry(mesh,world=false){
 if(!mesh)return [];mesh.updateWorldMatrix(true,false);const v=new THREE.Vector3(),out=[];
 for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,v);if(world)v.applyMatrix4(mesh.matrixWorld);out.push(v.x,v.y,v.z);}return out;
}
function findActor(id){return sceneController?.allActors().find(actor=>actor.id===id)||null;}
function getActorGeometry(id,world=false){return posedGeometry(findActor(id)?.body,world);}
function getActorMetrics(id){return findActor(id)?.metrics()||null;}
function getActorBounds(id){const actor=findActor(id);if(!actor)return null;const b=actor.bounds(),serialize=box=>({min:box.min.toArray(),max:box.max.toArray()});return {body:serialize(b.bodyBounds),face:serialize(b.faceBounds)};}
function getActorProjection(id){const actor=findActor(id);if(!actor)return null;camera.updateMatrixWorld(true);const p=actor.bounds().bodyBounds.getCenter(new THREE.Vector3()).project(camera);return {x:(p.x*.5+.5)*$('viewport').clientWidth,y:(-p.y*.5+.5)*$('viewport').clientHeight,z:p.z};}
let disposePicking=()=>{},editorBridge;
function dispose(){
 if(exporting)throw Error('Дождись завершения экспорта');
 editorLanguage.dispose();if(!ready&&!sceneController)return;ready=false;cancelAnimationFrame(frame);frame=0;resizeObserver.disconnect();
 editorBridge?.dispose();disposePicking();jointPicker?.dispose();kinematicUI?.dispose();sheetUI?.dispose();sceneUI?.dispose();sectionUI?.dispose();sheetLabels?.remove();
 rigUI?.dispose();faceUI?.dispose();identityUI?.dispose();identityMarkers?.dispose();renderUI?.dispose();
 // Remove any remaining owned overlays after adapter cleanup.
 document.querySelectorAll('.face-overlay').forEach(node=>node.remove());
 sceneController?.dispose();sceneController=null;activeActor=null;eyeTexture?.dispose();eyeTexture=null;
 cameraController.dispose();controls.dispose();renderer.dispose();renderer.forceContextLoss();
}
window.character3D={
 getState,setState,getEditorState,setEditorState,getActorGeometry,getActorMetrics,getActorBounds,getActorProjection,
 getJointProjections:()=>jointPicker?.projection()||[],setCameraMode:value=>cameraController.setMode(value),getCameraMode:()=>cameraController.mode(),
 exportPNG,front,getSheetCellCamera,inspectSheetCell,captureSheetCell,
 metrics:()=>({ready,frames,updateMs,loadBytes,vertices:body?.geometry.attributes.position.count,triangles:(body?.geometry.index.count||0)/3,eyesVertices:eyes?.geometry.attributes.position.count||0,drawCalls:renderer.info.render.calls,renderTriangles:renderer.info.render.triangles,webgl2:true,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,rig:activeActor?.rig.metrics()}),
 getPosedGeometry:()=>posedGeometry(body),getEyeGeometry:()=>posedGeometry(eyes),
 faceMetrics:()=>faceUI?.metrics(),contactMetrics:()=>faceContact?.metrics(),
 identityMetrics:()=>({newControls:identityCount,totalControls:identityUI?.count||0,groups:identityUI?.groups||[],markers:identityMarkers?.count||0}),
 getRigGeometry:()=>rigController.bones.flatMap(b=>b.getWorldPosition(new THREE.Vector3()).toArray()),
 getPartGeometry:()=>Object.fromEntries(partMeshes.map(p=>[p.source.id,posedGeometry(p.mesh)])),
 getSourceGeometry:()=>faceContact?.sourceGeometry()||Array.from(body.geometry.attributes.position.array),getSourcePosedGeometry:()=>faceContact?.sourcePosedGeometry(),
 getGeometry:()=>Array.from(body.geometry.attributes.position.array),dispose,
};
try{
 const response=await fetch('./assets/human.json');if(!response.ok)throw Error(`Данные модели: HTTP ${response.status}`);const text=await response.text();loadBytes=new TextEncoder().encode(text).length;data=JSON.parse(text);
 if(!Array.isArray(data.morphs))data.morphs=[];
 if(data.eyes){eyeTexture=await new THREE.TextureLoader().loadAsync('./assets/'+data.eyes.texture);eyeTexture.colorSpace=THREE.SRGBColorSpace;}
 let rigResponse=await fetch('./assets/face-rig.json');const hasFaceRig=rigResponse.ok;if(!hasFaceRig)rigResponse=await fetch('./assets/rig.json');if(!rigResponse.ok)throw Error('Скелет: HTTP '+rigResponse.status);
 const rigText=await rigResponse.text();loadBytes+=new TextEncoder().encode(rigText).length;const rig=rigData=JSON.parse(rigText);
 if(hasFaceRig){
  const r=await fetch('./assets/face-morphs.json');if(r.ok){const t=await r.text();loadBytes+=new TextEncoder().encode(t).length;faceMorphData=JSON.parse(t);data.morphs.push(...faceMorphData.morphs);}
  const attachments=await fetch('./assets/face-parts.json');if(attachments.ok){const t=await attachments.text();loadBytes+=new TextEncoder().encode(t).length;const parsed=JSON.parse(t);partsData=parsed.parts||parsed;}
 }
 const identityResponse=await fetch('./assets/identity.json');if(!identityResponse.ok)throw Error('Параметры внешности: HTTP '+identityResponse.status);const identityText=await identityResponse.text();loadBytes+=new TextEncoder().encode(identityText).length;
 identityCount=connectIdentity(JSON.parse(identityText),data,rig,partsData.map(source=>({source})));
 if(hasFaceRig){const response=await fetch('./assets/face-contact.json');if(!response.ok)throw Error('Контакт лица: HTTP '+response.status);contactDefinition=await response.json();}
 sceneController=createSceneController({initialState:state,createActor:record=>{
  let actor;actor=createCharacterActor({id:record.id,state:record.state,data,rigData,partsData,contactDefinition,eyeTexture,scene,camera,canvas:renderer.domElement,orbit:controls,isSheetView,
   onChange:pose=>{if(!ready||activeActor!==actor)return;if(pose){actor.state.pose=pose;updateModel(false);}poseUI();invalidate();}});return actor;
 },selected:selectRuntime,changed:syncScene,fit:()=>front()});
 state=sceneController.state;
 const sceneAPI={};for(const name of ['getMode','getActors','getSelected','setMode','selectActor','addActor','duplicateActor','removeActor','renameActor','setVisible','setPlacement','resetPlacement','fit'])sceneAPI[name]=(...args)=>{if(!ready)throw Error('Модель ещё не загружена');if(exporting)throw Error('Дождись завершения экспорта');return sceneController[name](...args);};
 window.character3D.scene=sceneAPI;
 ready=true;sceneUI=attachSceneUI({container:$('scene-panel'),api:window.character3D.scene});updateModel(true);controlsUI();initPoseUI();renderUI=attachRenderUI({state,controller:cameraController,changed:kind=>{scene.background=state.alpha?null:new THREE.Color(resolveCanvas(state).background);invalidate(kind==='render');},fit:front,copyView:()=>{if(state.view==='sheet'&&state.sheet){captureSheetCell();cameraController.setMode(true);return;}const nav=cameraController.editorState().viewport;cameraController.setRender(nav);cameraController.setMode(true);invalidate();}});renderUI.sync();
 sheetUI=attachSheetUI({container:$('canvas-panel'),state,canvas:()=>resolveCanvas({...state,view:'sheet'}),onInspect:inspectSheetCell,onCapture:captureSheetCell,changed:kind=>{controlsUI();cameraController.resized();renderUI.sync();controls.enabled=!isSheetView();rigController.viewChanged();invalidate(kind==='render');}});
 identityMarkers=attachIdentityMarkers({viewport:$('viewport'),camera,body:bodyProxy,data,state,orbit:controls,change:()=>updateModel(),invalidate,ui:identityUI,isSheetView:isActorToolHidden});
 rigUI=attachRigUI({section:$('pose-panel'),rig:rigController,changed:()=>invalidate(false)});
 kinematicUI=attachKinematicUI({container:$('pose-panel').parentElement,viewport:$('viewport'),canvas:renderer.domElement,camera,orbit:controls,rig:rigController,isSheet:isSheetView,change:()=>{poseUI();invalidate();},editorChange:()=>{$('joint').value=rigController.bones.findIndex(b=>b.name===rigController.values().name);poseUI();invalidate(false);}});
 disposePicking=attachActorPicking();
 jointPicker=attachJointPicker({viewport:$('viewport'),canvas:renderer.domElement,camera,rig:rigController,enabled:()=>rigUI.enabled(),isSheet:isSheetView,onSelect:p=>{$('joint').value=p.index;poseUI();invalidate(false);},onHover:p=>rigUI.hover(p)});
 if(hasFaceRig)faceUI=attachFaceUI({rig:rigController,rigData:rig,expressionData:faceMorphData,state,camera,viewport:$('viewport'),orbit:controls,change:()=>{updateModel(false);poseUI();},invalidate,isSheetView:isActorToolHidden});
 sectionUI=attachSectionUI({container:document.querySelector('aside'),sections:[['scene','Сцена'],['model','Модель'],['camera','Камера'],['canvas','Холст'],['sheet','Лист'],['material','Материал'],['identity','Внешность'],['face','Мимика'],['pose','Поза'],['kinematics','FK / IK'],['resources','Ресурсы']].map(([id,label])=>({id,label,element:$(id==='kinematics'?'kinematic-panel':id+'-panel')})),changed:()=>window.dispatchEvent(new Event('character3d:change'))});
 $('load').hidden=true;$('export').disabled=false;
 $('topology').textContent=`${data.positions.length/3} / ${data.indices.length/3}`;$('bytes').textContent=(loadBytes/1048576).toFixed(2)+' MiB';
 editorLanguage.text('status','Модель и скелет загружены. Доступны вращения суставов и экспорт PNG.');
 editorBridge=connectEditor(window.character3D);if(editorBridge)editorLanguage.release('status',editorBridge.setViewerStatus);
}catch(e){sceneController?.dispose();eyeTexture?.dispose();eyeTexture=null;$('load').hidden=false;editorLanguage.text('load',e.message);editorLanguage.text('status','Не удалось загрузить модель');console.error(e);}
