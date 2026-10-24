import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import * as localeCore from '../i18n.js';
import {EN} from '../web/i18n-editor.js';
import {attachIdentityUI} from '../identity-controls.js';
import {attachIdentityMarkers} from '../identity-markers.js';
import {attachRenderUI} from '../render-controls.js';
import {connectEditor} from '../editor-bridge.js';
import {layoutSheet,makeSheetPreset} from '../web/sheet-state.js';
import {defaults,stableState} from '../web/state.js';
import {Document} from './i18n-editor-dom.mjs';
const {t,setLanguage,messages}=localeCore;
const locale=l=>setLanguage(l,{persist:false}),cleanups=[];
afterEach(()=>{for(const fn of cleanups.splice(0))fn();locale('ru');for(const key of ['document','localStorage','window','parent','location'])delete globalThis[key];});
const source=await readFile(new URL('../viewer.js',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const metadata=JSON.parse(await readFile(new URL('../assets/identity.json',import.meta.url),'utf8')).morphs.map(({id,label,labelRu,negativeLabelRu,positiveLabelRu,min,max,group})=>({id,label,labelRu,negativeLabelRu,positiveLabelRu,min,max,group}));
// Execute the exact production presentation/pose functions only. Boot/render/fetch
// are deliberately excluded; this is not native viewer or Freeze acceptance.
function functionSource(name,next){const start=source.indexOf('function '+name+'('),end=source.indexOf(next,start);assert.ok(start>=0&&end>start);return source.slice(start,end);}
const languageSource=functionSource('attachEditorLanguageUI','const editorLanguage=');
const poseSource=source.slice(source.indexOf('function boneLabel('),source.indexOf('function poseUI('));
function mount(){locale('ru');const doc=new Document();doc.body.innerHTML=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g,'');globalThis.document=doc;return doc;}
const owned=ui=>{cleanups.push(()=>ui.dispose());return ui;};
const hash=value=>createHash('sha256').update(value).digest('hex');
function immutableFixture(){const state={...defaults(),morphs:{nose_width:.31},pose:{head:[.13,.04,0]},expressions:{smile:.42},faceOffsets:{jaw:[.01,0,0]},sheet:undefined};delete state.sheet;const editor={schema:'character-3d-editor/1',cameraMode:false,viewport:{position:[1,2,10],target:[0,1,0],zoom:1.2,height:8},openSections:['identity'],selectedJoint:'head'};const freeze={scene_json:stableState(state),snapshot_json:'{"snapshot":"immutable-sentinel"}',png_sha256:'a'.repeat(64)};return {state,editor,freeze,digests:()=>[hash(stableState(state)),hash(JSON.stringify(editor)),hash(JSON.stringify(freeze))]};}
function editorUI(doc){return owned(vm.runInNewContext(languageSource+';attachEditorLanguageUI(document)',{...localeCore,document:doc}));}

test('native header RU/EN selector and static leaf translations preserve mounted controls and drafts',()=>{
 const doc=mount(),ui=editorUI(doc),input=doc.getElementById('canvas-width'),select=doc.getElementById('canvas-preset'),option=select.children[0],language=doc.getElementById('ui-language'),before=immutableFixture(),hashes=before.digests();
 const inputs=doc.querySelectorAll('input'),refs=[...inputs],options=[...select.children];input.focus();input.value='-';select.value='custom';doc.getElementById('alpha').checked=true;doc.getElementById('export').disabled=true;
 const forbidden=()=>{throw Error('scene/render/model/graph callback during locale change');};for(const node of [...inputs,select]){node.oninput=forbidden;node.onchange=forbidden;}
 language.value='en';language.fire();assert.equal(doc.getElementById('save').textContent,'Save parameters');assert.equal(language.tagName,'SELECT');assert.deepEqual(language.children.map(o=>[o.value,o.textContent]),[['ru','RU'],['en','EN']]);assert.equal(language.getAttribute('aria-label'),'Interface language');
 assert.equal(doc.getElementById('load').textContent,'Loading the authored 3D mesh…');assert.equal(doc.getElementById('status').textContent,'Preparing scene');assert.equal(doc.getElementById('view-label').textContent,'Face · front');
 assert.deepEqual(doc.querySelectorAll('input'),refs);assert.deepEqual(select.children,options);assert.equal(select.children[0],option);assert.equal(option.textContent,'By view');assert.equal(select.value,'custom');assert.equal(input.value,'-');assert.equal(doc.activeElement,input);assert.equal(doc.getElementById('alpha').checked,true);assert.equal(doc.getElementById('export').disabled,true);assert.deepEqual(before.digests(),hashes);
 locale('ru');assert.equal(language.value,'ru');assert.equal(doc.getElementById('save').textContent,'Сохранить параметры');assert.equal(input.value,'-');assert.equal(doc.activeElement,input);
 ui.dispose();locale('en');assert.equal(language.value,'ru');assert.equal(option.textContent,'По виду');language.fire();assert.equal(localeCore.getLanguage(),'en');
});

test('static annotations cover every Russian leaf/mixed label and retain placeholder sets',()=>{
 const doc=mount();for(const node of doc.querySelectorAll('[data-i18n]')){assert.equal(node.children.length,0,node.getAttribute('data-i18n'));assert.ok(Object.hasOwn(messages,node.getAttribute('data-i18n')),node.getAttribute('data-i18n'));}
 const exceptions=new Set(['load','status','view-label','camera-mode-label']);
 for(const node of doc.querySelectorAll('*')){if(/[А-Яа-яЁё]/.test(node._text)&&!exceptions.has(node.id))assert.ok(node.hasAttribute('data-i18n'),node.tagName+': '+node._text);}
 for(const [key,value]of Object.entries(EN)){assert.doesNotMatch(value,/[А-Яа-яЁё]/,key);assert.deepEqual([...key.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),key);}
 assert.match(html,/html:lang\(en\) \.capture-locked::after\{content:"Freeze: saving snapshot…"\}/);
});

test('dynamic viewer status/error/performance keeps source for RU↔EN and preserves unknown details',()=>{
 const doc=mount(),ui=editorUI(doc);ui.text('status','PNG экспортирован. Включённые подписи листа входят в PNG и маску; служебные элементы — нет.');locale('en');assert.match(doc.getElementById('status').textContent,/PNG exported/);locale('ru');assert.match(doc.getElementById('status').textContent,/PNG экспортирован/);
 ui.text('load','Данные модели: HTTP 503');ui.text('perf','{triangles} трис / кадр · {ms} ms форма',{triangles:12000,ms:'0.7'});locale('en');assert.equal(doc.getElementById('load').textContent,'Model data: HTTP 503');assert.equal(doc.getElementById('perf').textContent,'12000 tris / frame · 0.7 ms shape');
 ui.text('status','HTTP 418: Андрей {custom} <literal>');locale('ru');assert.equal(doc.getElementById('status').textContent,'HTTP 418: Андрей {custom} <literal>');locale('en');assert.equal(doc.getElementById('status').textContent,'HTTP 418: Андрей {custom} <literal>');
 ui.dispose();locale('ru');assert.equal(doc.getElementById('load').textContent,'Model data: HTTP 503');
});

test('viewer releases status ownership to bridge instead of overwriting Freeze copy',()=>{
 const doc=mount(),ui=editorUI(doc);ui.release('status');const status=doc.getElementById('status');status.textContent='Freeze: рендер и сохранение PNG…';locale('en');assert.equal(status.textContent,'Freeze: рендер и сохранение PNG…');
 assert.match(source,/editorBridge=connectEditor\(window.character3D\);if\(editorBridge\)editorLanguage.release\('status',editorBridge.setViewerStatus\)/);
});

for(const [name,viewerSource,english]of [
 ['Load parameters','Параметры, поза и камеры восстановлены.','Parameters, pose and cameras restored.'],
 ['Export PNG','PNG экспортирован. Включённые подписи листа входят в PNG и маску; служебные элементы — нет.','PNG exported. Enabled sheet captions are included in the PNG and mask; editor helpers are excluded.'],
])test(`permanent status handoff keeps ${name} bilingual but never overwrites pending Freeze`,async()=>{
 const doc=mount(),ui=editorUI(doc),handlers=new Map(),sent=[],calls=[],state=defaults(),token='c'.repeat(32),parent={postMessage:message=>sent.push(message)};let resolvePNG;
 const api={getState:()=>{calls.push('read');return state;},setState:()=>calls.push('write'),exportPNG:()=>{calls.push('export');return new Promise(resolve=>{resolvePNG=resolve;});}};
 const window={parent,character3D:api,addEventListener:(key,fn)=>handlers.set(key,fn),removeEventListener:(key,fn)=>{if(handlers.get(key)===fn)handlers.delete(key);}};
 Object.assign(globalThis,{window,parent,location:{search:'?token='+token,origin:'http://cpu.test'}});
 // Execute the exact production bridge hookup, not an invented ownership arrangement.
 const start=source.indexOf('editorBridge=connectEditor(window.character3D);');assert.ok(start>=0);const hookup=source.slice(start,source.indexOf('\n',start)),context={window,editorLanguage:ui,connectEditor};vm.runInNewContext(hookup,context);const bridge=owned(context.editorBridge);
 const message=data=>handlers.get('message')({origin:location.origin,source:parent,data:{channel:'character-3d',token,...data}});
 message({action:'init',state});const status=doc.getElementById('status'),before=stableState(state);
 ui.text('status',viewerSource);locale('en');assert.equal(status.textContent,english);locale('ru');assert.equal(status.textContent,viewerSource);
 const capture=bridge.freeze();assert.equal(bridge.busy(),true);assert.equal(status.textContent,'Freeze: рендер и сохранение PNG…');const callsBefore=[...calls];sent.length=0;
 const flags=()=>doc.querySelectorAll('button,input,select').map(node=>[node,node.disabled,node.hidden,node.checked,node.id==='ui-language'?'locale':node.value]);const locked=flags();
 locale('en');assert.equal(status.textContent,'Freeze: rendering and saving PNG…','stale viewer binding must not reclaim the busy bridge status');assert.deepEqual(calls,callsBefore);assert.deepEqual(sent.map(m=>m.action),['language']);assert.deepEqual(flags(),locked);
 ui.text('status',viewerSource);assert.equal(status.textContent,'Freeze: rendering and saving PNG…','viewer writes during busy are suppressed, not queued');locale('ru');assert.equal(status.textContent,'Freeze: рендер и сохранение PNG…');assert.deepEqual(calls,callsBefore);
 resolvePNG(new Blob(['CPU transport fixture'],{type:'image/png'}));await capture;const request=sent.find(m=>m.action==='freeze');assert.ok(request);assert.equal(bridge.busy(),true);
 ui.text('status',viewerSource);locale('en');assert.equal(status.textContent,'Freeze: rendering and saving PNG…','upload/readback wait also retains Freeze priority');assert.deepEqual(flags(),locked);
 const detail=name==='Load parameters'?'CPU backend detail: ENOSPC':null;message({action:'freeze-result',requestId:request.requestId,...(detail?{error:detail}:{})});assert.equal(bridge.busy(),false);assert.equal(status.textContent,detail?'Freeze failed: '+detail:'Frozen PNG saved. New changes reach the output only after the next Freeze.');locale('ru');assert.equal(status.textContent,detail?'Freeze не выполнен: '+detail:'Frozen PNG сохранён. Новые изменения попадут в выход только после следующего Freeze.');assert.equal(stableState(state),before);
 // A new idle viewer action gets bilingual copy through the same owner, not a new binding.
 ui.text('status',viewerSource);locale('en');assert.equal(status.textContent,english);locale('ru');assert.equal(status.textContent,viewerSource);
 bridge.dispose();const last=status.textContent;ui.text('status',viewerSource);locale('en');assert.equal(status.textContent,last,'disposed bridge cannot be replaced by a reacquired viewer binding');
});

for(const initial of ['ru','en'])test(`second-cycle permanent handoff seeds canonical model-loaded status before init and transfers params (${initial})`,()=>{
 const doc=mount(),ui=editorUI(doc),handlers=new Map(),sent=[],calls=[],token='d'.repeat(32),parent={postMessage:message=>sent.push(message)},window={parent,addEventListener:(key,fn)=>handlers.set(key,fn),removeEventListener:(key,fn)=>{if(handlers.get(key)===fn)handlers.delete(key);}};
 Object.assign(globalThis,{window,parent,location:{search:'?token='+token,origin:'http://cpu.test'}});
 const canonical='Модель и скелет загружены. Доступны вращения суставов и экспорт PNG.',english='Model and skeleton loaded. Joint rotation and PNG export are available.';
 ui.text('status',canonical);locale(initial);const start=source.indexOf('editorBridge=connectEditor(window.character3D);');window.character3D={getState:()=>{calls.push('read');return defaults();},setState:()=>calls.push('write')};
 const context={window,editorLanguage:ui,connectEditor};vm.runInNewContext(source.slice(start,source.indexOf('\n',start)),context);const bridge=owned(context.editorBridge),status=doc.getElementById('status');assert.equal(bridge.initialized(),false);
 locale('en');assert.equal(status.textContent,english,'new bridge owns the current canonical copy before init');locale('ru');assert.equal(status.textContent,canonical);assert.deepEqual(calls,[]);assert.deepEqual(sent.map(m=>m.action),['ready',...(initial==='ru'?['language']:[]),'language']);
 // A second transfer seeds source+params, never the already-translated DOM text.
 const other=doc.getElementById('load'),captured=[];ui.text('load','Данные модели: HTTP {status}',{status:503});locale('en');ui.release('load',(source,params)=>{captured.push([source,params]);other.textContent=t(source,params);});assert.deepEqual(captured,[['Данные модели: HTTP {status}',{status:503}]]);assert.equal(other.textContent,'Model data: HTTP 503');locale('ru');assert.equal(other.textContent,'Model data: HTTP 503','old binding is permanently removed');ui.text('load','Данные модели: HTTP {status}',{status:404});assert.equal(other.textContent,'Данные модели: HTTP 404');
});

test('actual bridge language callback keeps current Freeze/draft status without scene reads/writes or draft notifications',()=>{
 const doc=mount(),ui=editorUI(doc),handlers=new Map(),sent=[],calls=[],state=defaults(),token='b'.repeat(32),parent={postMessage:message=>sent.push(message)},window={parent,addEventListener:(key,fn)=>handlers.set(key,fn),removeEventListener:(key,fn)=>{if(handlers.get(key)===fn)handlers.delete(key);}};
 Object.assign(globalThis,{window,parent,location:{search:'?token='+token,origin:'http://cpu.test'}});
 const bridge=owned(connectEditor({getState:()=>{calls.push('state read');return state;},setState:()=>calls.push('state write')}));ui.release('status');
 handlers.get('message')({origin:location.origin,source:parent,data:{channel:'character-3d',token,action:'init',state}});calls.length=0;sent.length=0;const status=doc.getElementById('status'),before=stableState(state);
 locale('en');assert.equal(status.textContent,'Draft opened. Click Freeze to send the image to the graph.');assert.equal(doc.querySelector('.tag').textContent,'ComfyUI · draft');assert.equal(stableState(state),before);assert.deepEqual(calls,[]);assert.deepEqual(sent.map(m=>m.action),['language']);
 locale('ru');assert.equal(status.textContent,'Черновик открыт. Нажми Freeze для передачи изображения в граф.');assert.deepEqual(calls,[]);bridge.dispose();
});

test('authored sheet captions remain literal and mounted during RU↔EN switches',()=>{
 const doc=mount(),ui=editorUI(doc),sheet=makeSheetPreset('grid');sheet.labels=true;sheet.cells[0].label='Лицо';sheet.cells[1].label='Сброс';sheet.cells[2].label='{triangles}';sheet.cells[3].label='<literal>';
 const state={view:'sheet',sheet},before=JSON.stringify(state),context={document:doc,state,sheetLabels:null,isSheetView:()=>true,resolveCanvas:()=>({width:1024,height:1024}),cameraController:{frame:()=>({x:0,y:0,width:1024,height:1024})},layoutSheet,$:id=>doc.getElementById(id)};
 vm.runInNewContext(functionSource('projectSheetLabels','function render(')+';projectSheetLabels()',context);const overlay=doc.querySelector('.sheet-label-overlay'),nodes=[...overlay.children];locale('en');assert.deepEqual(overlay.children,nodes);assert.deepEqual(nodes.map(n=>n.textContent),['Лицо','Сброс','{triangles}','<literal>']);assert.equal(JSON.stringify(state),before);locale('ru');assert.deepEqual(overlay.children,nodes);ui.dispose();
});

function identityFixture(){const doc=mount(),calls=[],f=immutableFixture();let guardReads=false;const state=new Proxy(f.state,{get(target,key){if(guardReads)throw Error('Language switch read model state: '+String(key));return Reflect.get(target,key);}});const morphs=[...metadata,{id:'nose_width',label:'Nose width',min:0,max:1}];const ui=owned(attachIdentityUI({container:doc.getElementById('morphs'),morphs,state,change:()=>calls.push('model/render')}));return {doc,ui,calls,f,morphs,guardReads:value=>{guardReads=value;},$:id=>doc.getElementById(id)};}
test('all shipped identity labels/endpoints/accessibility switch in place without state/focus/value changes',()=>{
 const f=identityFixture(),range=f.$('shape-identity_head_width'),number=f.doc.querySelector('[data-morph-value="identity_head_width"]'),rows=f.doc.querySelectorAll('[data-shape-row]'),before=f.f.digests(),details=f.doc.querySelectorAll('details'),open=details.map(n=>n.open);
 number.focus();number.value='0.';f.guardReads(true);locale('en');assert.equal(f.$('shape-search').getAttribute('placeholder'),'Find a parameter…');assert.equal(f.$('shape-count').textContent,`${f.morphs.length} / ${f.morphs.length} parameters`);
 assert.equal(number.getAttribute('aria-label'),'Head width · exact value');assert.equal(range.getAttribute('aria-label'),'Head width');assert.equal(number.value,'0.');assert.equal(f.doc.activeElement,number);assert.deepEqual(f.doc.querySelectorAll('[data-shape-row]'),rows);assert.deepEqual(details.map(n=>n.open),open);assert.deepEqual(f.f.digests(),before);assert.deepEqual(f.calls,[]);
 for(const m of metadata){const row=f.doc.querySelector(`[data-shape-row="${m.id}"]`);assert.equal(row.querySelector('label').textContent,m.label);assert.doesNotMatch(row.querySelector('.identity-endpoints').textContent,/[А-Яа-яЁё]/);assert.ok(Object.hasOwn(EN,m.labelRu),m.id);for(const key of [m.negativeLabelRu,m.positiveLabelRu])assert.ok(Object.hasOwn(EN,key),key);}
 locale('ru');assert.equal(range.getAttribute('aria-label'),'Ширина головы');assert.equal(number.value,'0.');assert.deepEqual(f.calls,[]);
 f.ui.dispose();locale('en');assert.equal(range.getAttribute('aria-label'),'Ширина головы');range.value='.8';range.fire('input');f.ui.sync();assert.deepEqual(f.f.digests(),before);assert.deepEqual(f.calls,[]);
});

test('Russian and English search work in either language; switching does not re-filter/reopen details',()=>{
 const f=identityFixture(),search=f.$('shape-search');for(const language of ['ru','en']){locale(language);for(const q of ['ширина головы','HEAD WIDTH','голова, лоб','forehead and cheeks','identity_head_width']){search.value=q;search.fire('input');assert.equal(f.doc.querySelector('[data-shape-row="identity_head_width"]').hidden,false,q);}}
 search.value='head width';search.fire('input');const rows=f.doc.querySelectorAll('[data-shape-row]'),visibility=rows.map(n=>n.hidden),details=f.doc.querySelectorAll('details');details[0].open=false;search.focus();locale('ru');assert.equal(search.value,'head width');assert.equal(f.doc.activeElement,search);assert.equal(details[0].open,false);assert.deepEqual(rows.map(n=>n.hidden),visibility);assert.deepEqual(f.calls,[]);
 search.value='not-found-query';search.fire('input');assert.equal(f.$('shape-empty').hidden,false);locale('en');assert.equal(f.$('shape-empty').textContent,'No parameters found.');
});

test('identity markers translate title and aria without projection, controls, scene or render calls',()=>{
 const doc=mount(),f=immutableFixture(),calls=[],morphs=[{id:'identity_head_width',labelRu:'Ширина головы',delta:[.1,0,0],min:-1,max:1},{id:'identity_head_height',labelRu:'Высота головы',min:-1,max:1}],ui=owned(attachIdentityMarkers({viewport:doc.getElementById('viewport'),camera:{},body:{getVertexPosition:()=>calls.push('geometry')},data:{morphs,positions:[1,1,1]},state:f.state,orbit:{enabled:true},change:()=>calls.push('model'),invalidate:()=>calls.push('invalidate'),ui:{focusGroup:()=>calls.push('focus'),sync:()=>calls.push('sync')}}));
 const marker=doc.querySelector('[data-shape-marker]'),check=doc.getElementById('shape-markers'),overlay=doc.querySelector('.identity-overlay'),before=f.digests();check.checked=true;marker.focus();locale('en');assert.equal(marker.title,'Head · horizontal: Head width; vertical: Head height');assert.equal(marker.getAttribute('aria-label'),'Head · change shape');assert.equal(doc.activeElement,marker);assert.equal(check.checked,true);assert.equal(overlay.hidden,true);assert.deepEqual(f.digests(),before);assert.deepEqual(calls,[]);locale('ru');assert.equal(marker.getAttribute('aria-label'),'Голова · изменить форму');ui.dispose();locale('en');assert.equal(marker.getAttribute('aria-label'),'Голова · изменить форму');marker.fire('pointerdown',{button:0});assert.deepEqual(calls,[]);
});

test('render copy switch preserves native options and incomplete drafts with zero controller reads/callbacks',()=>{
 const doc=mount(),f=immutableFixture(),calls=[];let mode=false;const controller={mode:()=>{calls.push('mode read');return mode;},frame:()=>{calls.push('frame read');return {x:1,y:2,width:300,height:400};},setMode:()=>calls.push('set mode'),resized:()=>calls.push('resize')};
 const ui=owned(attachRenderUI({state:f.state,controller,changed:k=>calls.push(k),fit:()=>calls.push('fit'),copyView:()=>calls.push('copy')}));ui.sync();const width=doc.getElementById('canvas-width'),preset=doc.getElementById('canvas-preset'),options=[...preset.children],before=f.digests(),meta=ui.metadata();width.focus();width.value='-';preset.value='custom';calls.length=0;locale('en');assert.equal(doc.getElementById('camera-mode-label').textContent,'Navigation · frame camera preserved');assert.equal(width.value,'-');assert.equal(doc.activeElement,width);assert.equal(preset.value,'custom');assert.deepEqual(preset.children,options);assert.deepEqual(ui.metadata(),meta);assert.deepEqual(f.digests(),before);assert.deepEqual(calls,[]);
 locale('ru');assert.equal(width.value,'-');width.value='4097';width.fire();calls.length=0;locale('en');assert.equal(doc.getElementById('canvas-error').textContent,'Canvas size: an integer from 1 to 4096.');assert.deepEqual(calls,[]);assert.deepEqual(f.digests(),before);ui.dispose();locale('ru');assert.equal(doc.getElementById('canvas-error').textContent,'Canvas size: an integer from 1 to 4096.');width.fire();assert.deepEqual(calls,[]);
});

test('production pose options and angle accessibility retain identity, selected joint, focus and values',async()=>{
 const doc=mount(),ui=editorUI(doc),calls=[],bones=JSON.parse(await readFile(new URL('../assets/face-rig.json',import.meta.url),'utf8')).bones.map(({name})=>({name}));
 const context={...localeCore,document:doc,editorLanguage:ui,$:id=>doc.getElementById(id),rigController:{bones,select:()=>calls.push('select'),setMode:()=>calls.push('mode'),rotation:()=>calls.push('rotation'),preset:()=>calls.push('preset')},poseUI:()=>{},invalidate:()=>calls.push('invalidate')};
 vm.runInNewContext(poseSource+';initPoseUI()',context);const joint=doc.getElementById('joint'),options=[...joint.children],head=options[bones.findIndex(b=>b.name==='head')],angle=doc.getElementById('angle-x');angle.focus();angle.value='13';joint.value='1';locale('en');assert.equal(head.textContent,'Head');assert.equal(options[bones.findIndex(b=>b.name==='index_01_l')].textContent,'Index finger 01 · left');assert.equal(options[bones.findIndex(b=>b.name==='levator02.L')].textContent,'levator02 · left');assert.equal(angle.getAttribute('aria-label'),'Rotation X');assert.equal(joint.value,'1');assert.equal(angle.value,'13');assert.equal(doc.activeElement,angle);assert.deepEqual(joint.children,options);assert.deepEqual(calls,[]);
 locale('ru');assert.equal(head.textContent,'Голова');assert.equal(angle.value,'13');ui.dispose();locale('en');assert.equal(head.textContent,'Голова');
});

test('language stays out of serialization/Freeze implementation, and all localized UI adapters are disposed',()=>{
 for(const [name,next]of [['getState','function getEditorState'],['getEditorState','function setEditorState'],['exportPNG',"$('export').onclick"]])assert.doesNotMatch(functionSource(name,next),/getLanguage|setLanguage|ui-language|language:/,name);
 const disposal=functionSource('dispose','window.character3D=');for(const name of ['editorLanguage','rigUI','faceUI','identityUI','identityMarkers','renderUI'])assert.match(disposal,new RegExp(name+'\\??\\.dispose\\('));
 for(const file of [languageSource])assert.doesNotMatch(file,/invalidate\(|dispatchEvent\(|requestAnimationFrame\(|updateModel\(|getState\(|getEditorState\(|render\(/);
});
