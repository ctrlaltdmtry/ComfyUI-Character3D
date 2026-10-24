import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setLanguage, t} from '../i18n.js';
import {EN} from '../web/i18n-controls.js';
import {attachSceneUI} from '../scene-controls.js';
import {attachSectionUI} from '../section-controls.js';
import {attachSheetUI} from '../sheet-controls.js';
import {attachRigUI} from '../rig-controls.js';
import {attachKinematicUI} from '../kinematic-controls.js';
import {attachFaceUI} from '../face-controller.js';
import {SECTION_IDS} from '../web/section-state.js';
import {makeSheetPreset} from '../web/sheet-state.js';

// CPU-only DOM surface. Parse static markup only; no browser, server or renderer.
class Element {
 constructor(tag, doc, ns='http://www.w3.org/1999/xhtml') {
  this.tagName=tag.toUpperCase(); this.ownerDocument=doc; this.namespaceURI=ns;
  this.children=[];this.parentNode=null;this.attributes=new Map();
  this.dataset=new Proxy({}, {set:(object,key,value)=>{object[key]=String(value);this.attributes.set('data-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),String(value));return true;}});
  this.handlers=new Map();this.style={};this.classes=new Set();this._text='';this._value=undefined;
  this.hidden=false;this.disabled=false;this.checked=false;
  this.classList={toggle:(n,on)=>{on??=!this.classes.has(n);on?this.classes.add(n):this.classes.delete(n);return on;},contains:n=>this.classes.has(n),add:n=>this.classes.add(n),remove:n=>this.classes.delete(n)};
 }
 get id(){return this.getAttribute('id')??'';} set id(v){this.setAttribute('id',v);}
 get title(){return this.getAttribute('title')??'';} set title(v){this.setAttribute('title',v);}
 get className(){return [...this.classes].join(' ');} set className(v){this.classes=new Set(v.split(/\s+/).filter(Boolean));}
 get value(){return this._value??(this.tagName==='SELECT'?this.children[0]?.value??'':'');} set value(v){this._value=String(v);}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(v){this._text=String(v);this.replaceChildren();}
 get firstChild(){return this.children[0]??null;}
 append(...nodes){for(const n of nodes){n.remove();n.parentNode=this;this.children.push(n);}}
 replaceChildren(...nodes){for(const n of this.children)n.parentNode=null;this.children=[];this.append(...nodes);}
 remove(){if(this.parentNode){const a=this.parentNode.children;a.splice(a.indexOf(this),1);this.parentNode=null;}}
 insertBefore(n,ref){n.remove();n.parentNode=this;this.children.splice(ref?this.children.indexOf(ref):this.children.length,0,n);}
 after(n){this.parentNode.insertBefore(n,this.parentNode.children[this.parentNode.children.indexOf(this)+1]??null);}
 before(n){this.parentNode.insertBefore(n,this);}
 setAttribute(k,v){this.attributes.set(k,String(v));if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v);}
 getAttribute(k){return this.attributes.get(k)??null;} hasAttribute(k){return this.attributes.has(k);}
 removeAttribute(k){this.attributes.delete(k);}
 addEventListener(e,fn){if(!this.handlers.has(e))this.handlers.set(e,new Set());this.handlers.get(e).add(fn);}
 removeEventListener(e,fn){this.handlers.get(e)?.delete(fn);}
 fire(e='change',extra={}){const ev={target:this,preventDefault(){},stopPropagation(){},...extra};for(const fn of this.handlers.get(e)??[])fn(ev);this['on'+e]?.(ev);}
 focus(){this.ownerDocument.activeElement=this;} click(){this.focus();if(!this.disabled)this.fire('click');}
 matches(selector){return selector.split(',').some(part=>{
  part=part.trim();if(part==='*')return true;if(part.startsWith('#'))return this.id===part.slice(1);if(part.startsWith('.'))return this.classes.has(part.slice(1));
  const m=/^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
  if(m)return (!m[1]||this.tagName===m[1].toUpperCase())&&this.hasAttribute(m[2])&&(m[3]===undefined||this.getAttribute(m[2])===m[3]);
  return this.tagName===part.toUpperCase();
 });}
 querySelectorAll(s){const out=[];for(const n of this.children){if(n.matches(s))out.push(n);out.push(...n.querySelectorAll(s));}return out;}
 querySelector(s){return this.querySelectorAll(s)[0]??null;}
 set innerHTML(html){
  this.replaceChildren();this._text='';const stack=[this];
  for(const token of html.match(/<[^>]*>|[^<]+/g)??[]){
   if(token.startsWith('</')){stack.pop();continue;}
   if(token.startsWith('<')){const tag=/^<(\w+)/.exec(token)[1],node=this.ownerDocument.createElement(tag);
    const attrs=token.slice(tag.length+1,-1);for(const m of attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)){
     const [,k,v='']=m;node.setAttribute(k,v);if(k==='class')node.className=v;if(['value','type','min','max','step'].includes(k))node[k]=v;if(k==='checked')node.checked=true;
    }
    stack.at(-1).append(node);if(!['input','br','hr'].includes(tag))stack.push(node);
   }else stack.at(-1)._text+=token;
  }
 }
}
class Document {
 constructor(){this.body=new Element('body',this);this.documentElement=new Element('html',this);this.activeElement=null;}
 createElement(tag){return new Element(tag,this);} createElementNS(ns,tag){return new Element(tag,this,ns);}
 getElementById(id){return this.body.querySelector('#'+id);}
}
const locale=l=>setLanguage(l,{persist:false});
const cleanups=[];
afterEach(()=>{for(const dispose of cleanups.splice(0))dispose();locale('ru');delete globalThis.document;});
function mountDoc(){locale('ru');const doc=new Document();globalThis.document=doc;return doc;}
function owned(ui){cleanups.push(()=>ui.dispose());return ui;}
function section(doc,id){const n=doc.createElement('section');n.id=id;doc.body.append(n);return n;}
const labels=['Сцена','Модель','Камера','Холст','Лист','Материал','Внешность','Мимика','Поза','Кинематика','Ресурсы'];

function sceneFixture(){
 const doc=mountDoc(),container=section(doc,'scene-panel'),state={mode:'single',selected:'one',actors:[{id:'one',name:'Лицо',visible:false,position:[1,2,3],rotation:[0,0,0]},{id:'two',name:'{name}<img>',visible:true,position:[0,0,0],rotation:[0,0,0]}]},calls=[];
 const api={getMode:()=>{calls.push('read');return state.mode;},getActors:()=>{calls.push('read');return state.actors;},getSelected:()=>{calls.push('read');return state.selected;}};
 for(const method of ['setMode','selectActor','addActor','duplicateActor','removeActor','renameActor','setVisible','setPlacement','resetPlacement','fit'])api[method]=()=>{calls.push(method);};
 const ui=owned(attachSceneUI({container,api,changed:()=>calls.push('changed')}));calls.length=0;
 return {doc,state,calls,api,ui,$:id=>doc.getElementById(id)};
}
test('scene switches in place without state reads, draft reset, focus loss or translating actor names',()=>{
 const f=sceneFixture(),input=f.$('scene-name'),option=f.$('scene-actors').children[0],before=JSON.stringify(f.state);
 input.focus();input.value='Черновик';f.$('scene-position-x').value='-';locale('en');
 assert.equal(f.$('scene-mode-single').textContent,'Single character');assert.equal(f.$('scene-actors').children[0],option);
 assert.equal(option.textContent,'Лицо · hidden');assert.equal(f.$('scene-actors').children[1].textContent,'{name}<img>');
 assert.equal(input.value,'Черновик');assert.equal(f.$('scene-position-x').value,'-');assert.equal(f.doc.activeElement,input);
 assert.equal(f.$('scene-position-x').parentNode.children[0].textContent,'X, dm');assert.equal(f.$('scene-actors').value,'one');
 assert.match(f.$('scene-limit').textContent,/Characters: 2 \/ 4/);assert.equal(JSON.stringify(f.state),before);assert.deepEqual(f.calls,[]);
 locale('ru');assert.equal(option.textContent,'Лицо · скрыт');assert.deepEqual(f.calls,[]);
});
test('scene inline errors retain their source across repeated switches and disposal stops retained copy',()=>{
 const f=sceneFixture(),input=f.$('scene-name');input.value='';input.fire();const error=f.$('scene-error');
 assert.match(error.textContent,/Имя:/);locale('en');assert.match(error.textContent,/Name:/);locale('ru');assert.match(error.textContent,/Имя:/);
 f.ui.dispose();const old=error.textContent;locale('en');assert.equal(error.textContent,old);input.value='test';input.fire();assert.deepEqual(f.calls,[]);
});
test('scene list rebuild releases bindings to obsolete actor options',()=>{
 const f=sceneFixture(),old=f.$('scene-actors').children[0];f.state.actors[0]={...f.state.actors[0],name:'Поза'};f.ui.sync();f.calls.length=0;locale('en');
 assert.equal(old.textContent,'Лицо · скрыт');assert.equal(f.$('scene-actors').children[0].textContent,'Поза · hidden');assert.deepEqual(f.calls,[]);
});
test('section tiles preserve SVGs, native controls, visibility, metadata and focus',()=>{
 const doc=mountDoc(),aside=doc.createElement('aside');doc.body.append(aside);const calls=[];
 const sections=SECTION_IDS.map((id,i)=>{const element=doc.createElement('section');element.id=id+'-panel';aside.append(element);return {id,label:labels[i],element};});
 const ui=owned(attachSectionUI({container:aside,sections,changed:k=>calls.push(k)})),tile=doc.getElementById('section-tile-pose'),svg=tile.children[0],meta=ui.metadata(),visibility=sections.map(s=>s.element.hidden);
 tile.focus();locale('en');assert.equal(tile.children[0],svg);assert.equal(tile.children[1].textContent,'Pose');assert.match(tile.title,/Pose · Shift: open/);
 assert.equal(doc.activeElement,tile);assert.deepEqual(ui.metadata(),meta);assert.deepEqual(sections.map(s=>s.element.hidden),visibility);assert.deepEqual(calls,[]);
 assert.equal(ui.root.getAttribute('aria-label'),'Editor sections');ui.dispose();locale('ru');assert.equal(tile.children[1].textContent,'Pose');
});
function sheetFixture(){
 const doc=mountDoc(),container=section(doc,'canvas-panel'),state={view:'sheet',sheet:makeSheetPreset('grid')},calls=[];let canvasReads=0;
 state.sheet.cells[0].label='Лицо';state.sheet.labels=true;
 const ui=owned(attachSheetUI({container,state,canvas:()=>{canvasReads++;return {width:1024,height:768};},changed:k=>calls.push(k)}));
 return {doc,state,calls,ui,get canvasReads(){return canvasReads;},$:id=>doc.getElementById(id)};
}
test('sheet switch preserves user captions, selections, drafts, camera/state and grid nodes without canvas calls',()=>{
 const f=sheetFixture(),cell=f.$('sheet-cell-0'),caption=f.$('sheet-cell-label'),rows=f.$('sheet-rows'),before=JSON.stringify(f.state),reads=f.canvasReads;
 caption.focus();caption.value='draft {view}';rows.value='3';rows.fire('input');locale('en');
 assert.equal(f.$('sheet-cell-0'),cell);assert.equal(cell.children[1].textContent,'Лицо');assert.equal(cell.title,'Cell 1 · Front');assert.equal(cell.getAttribute('aria-label'),'Cell 1 · Front · Лицо');
 assert.equal(f.$('sheet-cell-heading').textContent,'Cell 1 · row 1, column 1');assert.equal(f.$('sheet-cell-view').children[0].textContent,'Front');
 assert.equal(caption.value,'draft {view}');assert.equal(rows.value,'3');assert.equal(f.doc.activeElement,caption);
 assert.equal(JSON.stringify(f.state),before);assert.equal(f.canvasReads,reads);assert.deepEqual(f.calls,[]);assert.deepEqual(f.ui.metadata(),{sheetCell:0});
 locale('ru');assert.equal(cell.title,'Ячейка 1 · Анфас');assert.equal(caption.value,'draft {view}');
});
test('sheet status and errors update only presentation; disabled state and existing behavior remain',()=>{
 const f=sheetFixture();f.$('sheet-gutter').value='';f.$('sheet-gutter').fire();const reads=f.canvasReads,before=JSON.stringify(f.state);
 locale('en');assert.equal(f.$('sheet-error').textContent,'Enter a numeric value.');assert.equal(f.$('sheet-status').textContent,'Sheet · frame camera');
 assert.equal(f.$('sheet-inspect').disabled,true);assert.equal(f.canvasReads,reads);assert.equal(JSON.stringify(f.state),before);assert.deepEqual(f.calls,[]);
 const retained=f.$('sheet-status');f.ui.dispose();locale('ru');assert.equal(retained.textContent,'Sheet · frame camera');
});
test('sheet fallback view names translate while stored default captions stay byte-identical',()=>{
 const f=sheetFixture();f.state.sheet.labels=false;f.ui.sync();const before=JSON.stringify(f.state.sheet);locale('en');
 assert.equal(f.$('sheet-cell-0').children[1].textContent,'Front');assert.equal(JSON.stringify(f.state.sheet),before);
});
test('rig layers and hover descriptions switch without rig reads, mutations or notifications',()=>{
 const doc=mountDoc(),container=section(doc,'pose-panel'),heading=doc.createElement('h2');container.append(heading);const calls=[];
 const layers={bones:true,joints:false,controllers:false,body:true,hands:true,face:false,xray:false};
 const ui=owned(attachRigUI({section:container,rig:{getLayers:()=>{calls.push('read');return layers;},setLayers:()=>calls.push('set')},changed:()=>calls.push('changed')}));
 const box=container.children[1],note=doc.getElementById('joint-hover-label'),pick=doc.getElementById('pick-joints');calls.length=0;
 pick.focus();locale('en');assert.equal(box.querySelector('h3').textContent,'Rig layers');assert.match(note.textContent,/nearest joint/);assert.equal(doc.activeElement,pick);assert.equal(pick.checked,true);assert.deepEqual(calls,[]);
 ui.hover({id:'Лицо'});assert.equal(note.textContent,'Nearby: Лицо · click to select');locale('ru');assert.equal(note.textContent,'Рядом: Лицо · клик для выбора');assert.deepEqual(calls,[]);
 ui.dispose();locale('en');assert.equal(note.textContent,'Рядом: Лицо · клик для выбора');
});
function ikFixture(){
 const doc=mountDoc(),container=doc.createElement('aside'),viewport=doc.createElement('div'),canvas=doc.createElement('canvas');doc.body.append(container,viewport,canvas);
 const calls=[],values={id:'arm.L',mode:'ik',handle:'target',goals:{target:[1,2,3],pole:[4,5,6]},diagnostics:{ok:true}};
 const rig={kinematicValues:()=>{calls.push('values');return values;},getLayers:()=>{calls.push('layers');return {controllers:false,body:true};},selectLimb:()=>calls.push('select'),setLimbMode:()=>calls.push('mode'),selectIKHandle:()=>calls.push('handle'),setLimbGoal:()=>calls.push('goal')};
 const ui=owned(attachKinematicUI({container,viewport,canvas,camera:{},orbit:{enabled:true},rig,change:()=>calls.push('render'),editorChange:()=>calls.push('editor')}));calls.length=0;
 return {doc,viewport,values,calls,ui,$:id=>doc.getElementById(id)};
}
test('IK live copy switch never syncs/projects rig, touches goal drafts or changes marker topology',()=>{
 const f=ikFixture(),input=f.$('ik-vectors').querySelector('input'),marker=f.viewport.children[0],before=JSON.stringify(f.values);input.focus();input.value='1.';locale('en');
 assert.equal(f.$('ik-limb').children[0].textContent,'Left arm');assert.equal(input.getAttribute('aria-label'),'Target X');assert.equal(marker.title,'Left arm · target');assert.equal(marker.getAttribute('aria-label'),marker.title);
 assert.equal(input.value,'1.');assert.equal(f.doc.activeElement,input);assert.equal(f.viewport.children[0],marker);assert.equal(JSON.stringify(f.values),before);assert.deepEqual(f.calls,[]);
 assert.equal(f.$('ik-status').textContent,'IK · target and bend direction');f.ui.dispose();locale('ru');assert.equal(marker.title,'Left arm · target');
});
test('IK diagnostics translate current status and nested errors across switches',()=>{
 const f=ikFixture();for(const [diagnostics,english] of [[{angleClamped:true},'IK · angle limit; the target may be unreachable'],[{unreachable:true},'IK · target exceeds chain reach'],[{ok:false,error:{message:'Некорректный вектор FK/IK.'}},'IK: Invalid FK/IK vector.'],[{ok:false},'IK: calculation failed']]){
  locale('ru');f.values.diagnostics=diagnostics;f.ui.sync();f.calls.length=0;locale('en');assert.equal(f.$('ik-status').textContent,english);assert.deepEqual(f.calls,[]);
 }
 locale('ru');f.values.mode='fk';f.ui.sync();f.calls.length=0;locale('en');assert.equal(f.$('ik-status').textContent,'FK · hands and feet follow joint rotation');assert.deepEqual(f.calls,[]);
});
function faceFixture(morphs){
 const doc=mountDoc(),pose=section(doc,'pose-panel'),viewport=doc.createElement('div');doc.body.append(viewport);const calls=[];
 const ids=['eye_close_l','eye_close_r','brow_up_l','brow_up_r','brow_down_l','brow_down_r','smile_l','smile_r','frown_l','frown_r','smile','frown','lips_compress','cheeks'];
 const state={view:'body',pose:{jaw:[.1,.02,0]},expressions:{smile:.4},faceOffsets:{},faceSymmetry:true,expressionStrength:.7};
 const ui=owned(attachFaceUI({rig:{bones:[{name:'jaw'},{name:'eye.L'},{name:'eye.R'}]},rigData:{faceBones:['jaw','eye.L','eye.R'],controls:{jaw:'jaw',eyes:['eye.L','eye.R']}},expressionData:{morphs:morphs??ids.map(id=>({id}))},state,camera:{},viewport,orbit:{enabled:true},change:()=>calls.push('render'),invalidate:()=>calls.push('invalidate')}));
 return {doc,state,calls,viewport,ui,$:id=>doc.getElementById(id)};
}
test('face channels, markers and mixed output controls switch without pose resets or render calls',()=>{
 const f=faceFixture(),strength=f.$('expression-strength'),out=f.$('expression-value'),jaw=f.$('jaw-open'),panel=f.$('face-panel'),before=JSON.stringify(f.state),oldOut=out.textContent;
 jaw.focus();jaw.value='6.3';locale('en');assert.equal(f.$('jaw-open'),jaw);assert.equal(jaw.value,'6.3');assert.equal(f.doc.activeElement,jaw);assert.equal(out.textContent,oldOut);assert.equal(f.$('expression-strength'),strength);
 assert.equal(jaw.getAttribute('aria-label'),'Jaw · open');assert.equal(f.$('gaze-eye').children[0].textContent,'Both eyes');assert.equal(strength.getAttribute('aria-label'),'Expression strength');
 assert.equal(panel.querySelector('[data-expression="eye_close_l"]').getAttribute('aria-label'),'Left eye · close');assert.equal(panel.querySelector('[data-expression="cheeks"]').getAttribute('aria-label'),'Cheeks');
 assert.equal(f.viewport.querySelector('[data-face-marker="brow-l"]').title,'Left brow');assert.equal(f.viewport.querySelector('[data-face-marker="lip-r"]').getAttribute('aria-label'),'Right lip corner');
 assert.equal(JSON.stringify(f.state),before);assert.deepEqual(f.calls,[]);locale('ru');assert.equal(jaw.getAttribute('aria-label'),'Челюсть · открыть');assert.equal(jaw.value,'6.3');
});
test('all shipped face channels have bilingual captions, and dispose releases retained face bindings and events',async()=>{
 const morphs=JSON.parse(await readFile(new URL('../assets/face-morphs.json',import.meta.url),'utf8')).morphs.map(({id,label})=>({id,label}));
 const f=faceFixture(morphs),panel=f.$('face-panel'),inputs=panel.querySelectorAll('input[data-expression]'),marker=f.viewport.querySelector('[data-face-marker="jaw"]');
 assert.equal(inputs.length,morphs.length);
 for(const input of inputs){const ru=input.getAttribute('aria-label');locale('en');assert.doesNotMatch(input.getAttribute('aria-label'),/[А-Яа-яЁё]/);assert.notEqual(input.getAttribute('aria-label'),ru);locale('ru');assert.equal(input.getAttribute('aria-label'),ru);}
 locale('en');f.ui.dispose();locale('ru');assert.equal(marker.title,'Jaw');assert.ok([...marker.handlers.values()].every(set=>set.size===0));
 assert.equal(f.doc.getElementById('face-panel'),null);const before=JSON.stringify(f.state);inputs[0].value='.8';inputs[0].fire('input');f.ui.sync();assert.equal(JSON.stringify(f.state),before);assert.deepEqual(f.calls,[]);
});
test('control dictionary covers explicit UI annotations and keeps parameter placeholder sets intact',async()=>{
 for(const file of ['rig-controls.js','kinematic-controls.js','face-controller.js']){
  const source=await readFile(new URL('../'+file,import.meta.url),'utf8');
  for(const [,key]of source.matchAll(/data-i18n="([^"]+)"/g))assert.ok(Object.hasOwn(EN,key),file+': '+key);
 }
 for(const [key,value]of Object.entries(EN))assert.deepEqual([...key.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),key);
 locale('en');assert.equal(t('Рядом: jaw · клик для выбора'),'Nearby: jaw · click to select');
 assert.equal(t('Цепь FK/IK отсутствует: arm.L'),'FK/IK chain is missing: arm.L');
});
