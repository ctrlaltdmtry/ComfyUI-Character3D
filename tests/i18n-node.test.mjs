import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './i18n-node-harness.mjs';
const origin='http://qa.invalid',token='0123456789abcdef0123456789abcdef';
const state=()=>({schema:'character-3d-preview/1',sex:0,morphs:{},pose:{},expressions:{},faceOffsets:{},faceSymmetry:true,view:'portrait',material:'clay',skin:'#b98570',free:false,alpha:false,expressionPreset:'neutral',expressionStrength:1});
const button=(node,label)=>node._character3DCard.root.querySelector('button')&&node._character3DCard.root.children.flatMap(e=>e.children).find(e=>e.tagName==='BUTTON'&&e.textContent===label);

test('cards switch together with persistent live failures, no properties/input/graph mutations; removed cards unsubscribe',async()=>{
 const f=fixture(),create=await f.cards(),a=create(),b=create(),i=await f.load('web/i18n.js');
 const original=JSON.stringify([a.properties,b.properties,a.widgets.map(w=>w.value),b.widgets.map(w=>w.value)]),counts=f.counts();
 a._character3DCard.preview.onerror();const raw=a._character3DError;
 const select=a._character3DCard.root.querySelector('select');select.value='en';select.dispatch('change');
 assert.equal(b._character3DCard.root.querySelector('select').value,'en');assert.equal(f.stored.get('character3d.ui.language'),'en');
 assert.equal(a._character3DCard.status.textContent,'PNG not found. Open the editor and run Freeze.');assert.equal(a._character3DError,raw);
 assert.ok(button(a,'Editor'));assert.ok(button(a,'ZIP package'));assert.equal(a._character3DCard.preview.getAttribute('alt'),'Last Frozen PNG');
 a._character3DBusy=true;a._character3DCard.freezeButton.disabled=true;i.setLanguage('ru');assert.equal(a._character3DCard.status.textContent,'Freeze: сохранение PNG…');assert.equal(a._character3DCard.freezeButton.disabled,true);assert.equal(a._character3DBusy,true);
 a._character3DBusy=false;i.setLanguage('en');assert.equal(a._character3DCard.status.textContent,'PNG not found. Open the editor and run Freeze.');
 assert.equal(JSON.stringify([a.properties,b.properties,a.widgets.map(w=>w.value),b.widgets.map(w=>w.value)]),original);assert.deepEqual(f.counts(),counts);
 const card=b._character3DCard,selectB=card.root.querySelector('select');b.onRemoved();assert.equal(b._character3DCard,undefined);i.setLanguage('ru');assert.equal(selectB.value,'en');assert.ok(card.root.textContent.includes('Editor'));assert.equal(card.preview.onerror,null);a.onRemoved();
});

test('parent language messages use original origin/source/channel/token checks, strict values, init and unsubscribe',async()=>{
 const f=fixture(),create=await f.cards(),node=create(),i=await f.load('web/i18n.js');
 button(node,'Редактор').click();const iframe=f.elements.find(e=>e.tagName==='IFRAME'),dialog=f.doc.body.querySelector('dialog'),url=new URL(iframe.src);const auth={channel:'character-3d',token:url.searchParams.get('token'),action:'language',language:'en'};
 assert.equal(url.searchParams.get('lang'),'ru');assert.match(auth.token,/^[a-f0-9]{32}$/);
 const counts=f.counts(),saved=JSON.stringify([node.properties,node.widgets.map(w=>w.value)]);
 for(const extra of [{origin:'https://evil.invalid'},{source:{}},{data:{...auth,channel:'bad'}},{data:{...auth,token:'bad'}},{data:{...auth,language:'EN'}},{data:{...auth,language:'de'}},{data:{...auth,language:null}}]){await f.emit('message',{origin,source:iframe.contentWindow,data:auth,...extra});assert.equal(i.getLanguage(),'ru');}
 await f.emit('message',{origin,source:iframe.contentWindow,data:auth});assert.equal(i.getLanguage(),'en');assert.equal(dialog.getAttribute('aria-label'),'3D character editor');assert.equal(iframe.title,'3D character editor');
 assert.deepEqual(f.counts(),counts);assert.equal(JSON.stringify([node.properties,node.widgets.map(w=>w.value)]),saved);
 const languages=iframe.sent.filter(m=>m.data.action==='language').length;await f.emit('message',{origin,source:iframe.contentWindow,data:auth});assert.equal(iframe.sent.filter(m=>m.data.action==='language').length,languages);
 await f.emit('message',{origin,source:iframe.contentWindow,data:{...auth,action:'ready'}});assert.equal(iframe.sent.at(-1).data.action,'init');assert.equal(iframe.sent.at(-1).data.language,'en');assert.equal(iframe.sent.at(-1).data.freezeNow,false);
 node.onRemoved();assert.equal(f.handlers.get('message').size,0);const before=iframe.sent.length;i.setLanguage('ru');assert.equal(iframe.sent.length,before);
});

test('bridge authenticated locale/init synchronizes status/errors without touching editor APIs or dirty/change/Freeze',async()=>{
 const f=fixture();f.bridgeDOM();const {connectEditor}=await f.load('editor-bridge.js'),i=await f.load('web/i18n.js');let model=state(),sets=0,exports=0;
 const bridge=connectEditor({getState:()=>model,setState:s=>{sets++;model=s;},exportPNG:async()=>{exports++;throw Object.assign(Error('PNG превышает допустимое разрешение.'),{i18nSource:'PNG превышает допустимое разрешение.'});}});
 const message=async(data,extra={})=>f.emit('message',{origin,source:f.parent,data:{channel:'character-3d',token,...data},...extra});
 assert.equal(f.sent[0].data.action,'ready');
 for(const extra of [{origin:'https://evil.invalid'},{source:{}},{data:{channel:'other',token,action:'language',language:'en'}},{data:{channel:'character-3d',token:'bad',action:'language',language:'en'}}]){await message({action:'language',language:'en'},extra);assert.equal(i.getLanguage(),'ru');}
 for(const language of ['EN','de',null,{},1]){await message({action:'language',language});assert.equal(i.getLanguage(),'ru');}
 await message({action:'init',state:model,language:'en',freezeNow:false});assert.equal(sets,1);assert.equal(exports,0);assert.match(f.doc.querySelector('#status').textContent,/Draft opened/);
 const before=f.sent.length;i.setLanguage('ru');assert.equal(f.sent.length,before+1);assert.equal(f.sent.at(-1).data.action,'language');assert.equal(sets,1);assert.equal(exports,0);
 await bridge.freeze();assert.equal(bridge.busy(),false);assert.equal(exports,1);assert.equal(f.doc.querySelector('#status').textContent,'PNG превышает допустимое разрешение.');
 i.setLanguage('en');assert.equal(f.doc.querySelector('#status').textContent,'PNG exceeds the allowed resolution.');i.setLanguage('ru');assert.equal(f.doc.querySelector('#status').textContent,'PNG превышает допустимое разрешение.');assert.equal(sets,1);
 bridge.dispose();bridge.dispose();assert.equal(f.handlers.get('message').size,0);assert.equal(f.handlers.get('character3d:change').size,0);const length=f.sent.length;i.setLanguage('en');assert.equal(f.sent.length,length);assert.equal(f.doc.querySelector('#freeze').onclick,null);assert.equal(f.doc.querySelector('#close-editor').onclick,null);
});

test('in-flight bridge retains busy lock across locale changes and preserves exact failed backend details after result',async()=>{
 const f=fixture();f.bridgeDOM();const {connectEditor}=await f.load('editor-bridge.js'),i=await f.load('web/i18n.js');let resolvePNG;
 const bridge=connectEditor({getState:state,setState(){},exportPNG:()=>new Promise(resolve=>{resolvePNG=resolve;})});
 const message=data=>f.emit('message',{origin,source:f.parent,data:{channel:'character-3d',token,...data}});
 await message({action:'init',state:state()});const capture=bridge.freeze();assert.equal(bridge.busy(),true);
 i.setLanguage('en');assert.equal(bridge.busy(),true);assert.equal(f.doc.querySelector('#freeze').disabled,true);assert.equal(f.doc.querySelector('#close-editor').disabled,true);assert.equal(f.doc.querySelector('#status').textContent,'Freeze: rendering and saving PNG…');
 resolvePNG(new Blob(['unit-test-only'],{type:'image/png'}));await capture;const request=f.sent.find(m=>m.data.action==='freeze').data;
 await message({action:'freeze-result',requestId:'wrong',error:'wrong'});assert.equal(bridge.busy(),true);
 const detail='ENOSPC: H:/authored/Персонаж.png {raw}';await message({action:'freeze-result',requestId:request.requestId,error:detail});assert.equal(bridge.busy(),false);assert.equal(f.doc.querySelector('#status').textContent,'Freeze failed: '+detail);
 i.setLanguage('ru');assert.equal(f.doc.querySelector('#status').textContent,'Freeze не выполнен: '+detail);i.setLanguage('en');assert.equal(f.doc.querySelector('#status').textContent,'Freeze failed: '+detail);bridge.dispose();
});

test('disposing during pending capture cancels async post and keeps language callback detached',async()=>{
 const f=fixture();f.bridgeDOM();const {connectEditor}=await f.load('editor-bridge.js'),i=await f.load('web/i18n.js');let resolvePNG;
 const bridge=connectEditor({getState:state,setState(){},exportPNG:()=>new Promise(resolve=>{resolvePNG=resolve;})});
 await f.emit('message',{origin,source:f.parent,data:{channel:'character-3d',token,action:'init',state:state()}});const capture=bridge.freeze();bridge.dispose();const length=f.sent.length;i.setLanguage('en');resolvePNG(new Blob(['unit-test-only']));await capture;assert.equal(f.sent.length,length);assert.equal(bridge.busy(),false);
});

test('portable package errors are localized with raw sources; server details and returned authored workflow stay exact; no auto queue',async()=>{
 const f=fixture(),p=await f.load('web/package.js'),i=await f.load('web/i18n.js');i.setLanguage('en');
 await assert.rejects(p.importWorkflowPackage(f.app,f.api,null),e=>e.message==='A ZIP package up to 128 MiB is required.'&&e.i18nSource==='Ожидается ZIP-пакет до 128 MiB.');
 f.app.graph._nodes=[{_character3DBusy:true}];await assert.rejects(p.exportWorkflowPackage(f.app,f.api),/Wait for Freeze/);f.app.graph._nodes=[];
 f.api.fetchApi=async()=>({ok:false,status:503,json:async()=>({error:'Exact backend: invalid actor Имя {detail}'})});await assert.rejects(p.exportWorkflowPackage(f.app,f.api),e=>e.message==='Exact backend: invalid actor Имя {detail}'&&!e.i18nSource);
 f.api.fetchApi=async()=>({ok:false,status:503,json:async()=>{throw Error('no JSON');}});await assert.rejects(p.exportWorkflowPackage(f.app,f.api),e=>e.message==='Package export: HTTP 503'&&e.i18nSource==='Экспорт пакета: HTTP 503');
 const workflow={nodes:[{type:'Character3DEditor',properties:{name:'Русское имя'},widgets_values:['snapshot','scene']}],extra:{caption:'Мой кадр'}},response={workflow,characters:1};let posted;
 f.api.fetchApi=async(path,options)=>{posted={path,options};return {ok:true,json:async()=>response};};const file=new Blob(['unit-test-only']);const result=await p.importWorkflowPackage(f.app,f.api,file);assert.equal(result,response);assert.equal(f.loaded[0],workflow);assert.equal(posted.options.body,file);assert.equal(posted.options.headers['Content-Type'],'application/zip');assert.deepEqual(f.counts(),{graphChanges:0,dirty:0,loaded:1});
});

test('transfer controls display localized confirmation, busy and failure; active errors retranslate instead of clearing',async()=>{
 const f=fixture(),create=await f.cards(),node=create(),i=await f.load('web/i18n.js');i.setLanguage('en');let resolveRequest;
 f.api.fetchApi=()=>new Promise(resolve=>{resolveRequest=resolve;});const action=button(node,'ZIP package').click();const status=node._character3DCard.root.children.at(-2);
 assert.equal(status.textContent,'Checking and packaging workflow…');assert.equal(node._character3DCard.freezeButton.disabled,true);i.setLanguage('ru');assert.equal(status.textContent,'Проверка и упаковка workflow…');assert.equal(node._character3DCard.freezeButton.disabled,true);
 resolveRequest({ok:false,status:500,json:async()=>{throw Error('no JSON');}});await action;assert.equal(status.textContent,'Экспорт пакета: HTTP 500');i.setLanguage('en');assert.equal(status.textContent,'Package export: HTTP 500');assert.equal(node._character3DCard.freezeButton.disabled,false);
 let confirmation;f.globals.confirm=text=>{confirmation=text;return false;};button(node,'Import ZIP').click();const picker=f.elements.at(-1);picker.files=[new Blob(['unit-test-only'])];picker.onchange();assert.match(confirmation,/Import will replace the current workflow/);assert.match(confirmation,/Graph execution will not start/);assert.deepEqual(f.counts(),{graphChanges:0,dirty:0,loaded:0});node.onRemoved();
});

test('separate parent/editor realms synchronize bidirectionally without storage events or echo cycles/state mutations',async()=>{
 const p=fixture(),make=await p.cards(),a=make(),b=make(),pi=await p.load('web/i18n.js');button(a,'Редактор').click();
 const iframe=p.elements.find(e=>e.tagName==='IFRAME'),url=new URL(iframe.src),c=fixture();c.globals.location.search=url.search;c.bridgeDOM();const pending=[],traffic=[];
 iframe.contentWindow.postMessage=(data,target)=>{assert.equal(target,origin);traffic.push({from:'parent',data});pending.push(c.emit('message',{origin,source:c.parent,data}));};
 c.parent.postMessage=(data,target)=>{assert.equal(target,origin);traffic.push({from:'editor',data});pending.push(p.emit('message',{origin,source:iframe.contentWindow,data}));};
 const ci=await c.load('web/i18n.js'),{connectEditor}=await c.load('editor-bridge.js');let sets=0,exports=0,model=state();
 const bridge=connectEditor({getState:()=>model,setState:s=>{model=s;sets++;},exportPNG:async()=>{exports++;throw Error('not called');}});
 const drain=async()=>{let count=0;while(pending.length){assert.ok(count++<10,'no message cycle');await Promise.all(pending.splice(0));}};await drain();assert.equal(sets,1);assert.equal(exports,0);
 assert.equal(traffic.filter(m=>m.data.action==='language').length,0,'remote init never replies with language');traffic.length=0;
 const original=JSON.stringify([a.properties,b.properties,a.widgets.map(w=>w.value),b.widgets.map(w=>w.value),model]),counts=p.counts();
 const select=a._character3DCard.root.querySelector('select');select.value='en';select.dispatch('change');await drain();assert.equal(ci.getLanguage(),'en');assert.equal(b._character3DCard.root.querySelector('select').value,'en');assert.match(c.doc.querySelector('#status').textContent,/Draft opened/);
 assert.deepEqual(traffic.map(m=>[m.from,m.data.action,m.data.language]),[['parent','language','en']],'exactly one local outbound message and zero receiver echoes');traffic.length=0;
 ci.setLanguage('ru');await drain();assert.equal(pi.getLanguage(),'ru');assert.equal(select.value,'ru');assert.equal(b._character3DCard.root.querySelector('select').value,'ru');assert.equal(sets,1);assert.equal(exports,0);assert.deepEqual(p.counts(),counts);assert.equal(JSON.stringify([a.properties,b.properties,a.widgets.map(w=>w.value),b.widgets.map(w=>w.value),model]),original);
 assert.deepEqual(traffic.map(m=>[m.from,m.data.action,m.data.language]),[['editor','language','ru']],'reverse direction also has zero receiver echoes');
 bridge.dispose();a.onRemoved();b.onRemoved();
});

test('bridge does not overwrite newer viewer-owned status on locale change; removed pending picker cannot import',async()=>{
 const f=fixture();f.bridgeDOM();const {connectEditor}=await f.load('editor-bridge.js'),i=await f.load('web/i18n.js');const bridge=connectEditor({getState:state,setState(){}});
 await f.emit('message',{origin,source:f.parent,data:{channel:'character-3d',token,action:'init',state:state()}});f.doc.querySelector('#status').textContent='Latest viewer backend error: exact details';i.setLanguage('en');assert.equal(f.doc.querySelector('#status').textContent,'Latest viewer backend error: exact details');bridge.dispose();
 const p=fixture(),make=await p.cards(),node=make();button(node,'Импорт ZIP').click();const picker=p.elements.at(-1),handler=picker.onchange;node.onRemoved();assert.equal(picker.onchange,null);picker.files=[new Blob(['unit-test-only'])];handler();assert.equal(p.counts().loaded,0);
});

test('Freeze retains existing hidden widget aliases and synchronous scene/snapshot pair commit after locale switch',async()=>{
 // This known 1x1 PNG is an upload-contract fixture, not editor-rendered output or GPU verification.
 const pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZ0AAAAASUVORK5CYII=','base64');
 const f=fixture(),make=await f.cards(),node=make(),i=await f.load('web/i18n.js');assert.equal(node.widgets[0].name,'snapshot');assert.equal(node.widgets[1].name,'scene_json');for(const w of node.widgets){assert.equal(w.type,'converted-widget');assert.equal(w.hidden,true);assert.equal(JSON.stringify(w.computeSize()),'[0,-4]');}
 button(node,'Редактор').click();const iframe=f.elements.find(e=>e.tagName==='IFRAME'),authToken=new URL(iframe.src).searchParams.get('token');let resolveUpload,uploaded;
 f.api.fetchApi=async(path,options)=>{if(path==='/upload/image'){uploaded=await options.body.get('image').arrayBuffer();return new Promise(resolve=>{resolveUpload=resolve;});}assert.ok(path.startsWith('/view?'));return {ok:true,arrayBuffer:async()=>uploaded};};
 const pair=()=>node.widgets.map(w=>w.value),callbacks=[];for(const w of node.widgets)w.callback=()=>callbacks.push({name:w.name,pair:pair()});
 const request=f.emit('message',{origin,source:iframe.contentWindow,data:{channel:'character-3d',token:authToken,action:'freeze',requestId:'fixture-request',state:state(),png:new Blob([pngBytes],{type:'image/png'})}});
 for(let attempts=0;!resolveUpload&&attempts<20;attempts++)await new Promise(resolve=>setImmediate(resolve));assert.ok(resolveUpload,'upload request reached');assert.equal(node._character3DBusy,true);const before=f.counts(),inputs=JSON.stringify(pair());i.setLanguage('en');assert.deepEqual(f.counts(),before);assert.equal(JSON.stringify(pair()),inputs);assert.equal(node._character3DBusy,true);
 resolveUpload({ok:true,json:async()=>({type:'input',subfolder:'character_3d',name:'c3d_0123456789abcdef0123456789abcdef.png'})});await request;
 assert.equal(callbacks.length,2);assert.equal(callbacks[0].name,'scene_json');assert.equal(callbacks[1].name,'snapshot');assert.deepEqual(callbacks[0].pair,pair());assert.deepEqual(callbacks[1].pair,pair());const scene=JSON.parse(node.widgets[1].value);assert.equal(scene.schema,'character-3d-snapshot/1');assert.match(scene.png_sha256,/^[a-f0-9]{64}$/);assert.equal(Object.hasOwn(scene,'language'),false);assert.equal(Object.hasOwn(scene.state,'language'),false);
 assert.equal(node.widgets[0].value,'character_3d/c3d_0123456789abcdef0123456789abcdef.png');assert.equal(node._character3DBusy,false);assert.equal(iframe.sent.at(-1).data.action,'freeze-result');assert.equal(iframe.sent.at(-1).data.requestId,'fixture-request');assert.equal(node._character3DCard.status.textContent,'Frozen · IMAGE ready');node.onRemoved();
});

test('incoming parent locale sends zero replies to its origin session but synchronizes other open sessions',async()=>{
 const f=fixture(),make=await f.cards(),a=make(),b=make(),i=await f.load('web/i18n.js');
 button(a,'Редактор').click();button(b,'Редактор').click();const [first,second]=f.elements.filter(e=>e.tagName==='IFRAME');
 const incoming=language=>f.emit('message',{origin,source:first.contentWindow,data:{channel:'character-3d',token:new URL(first.src).searchParams.get('token'),action:'language',language}});
 const counts=f.counts(),saved=JSON.stringify([a.properties,b.properties,a.widgets,b.widgets]);
 await incoming('en');assert.equal(first.sent.length,0,'remote apply must not echo to originating editor');assert.equal(second.sent.length,1);assert.equal(second.sent[0].data.language,'en');assert.equal(second.sent[0].origin,origin);assert.equal(second.sent[0].data.channel,'character-3d');assert.equal(second.sent[0].data.token,new URL(second.src).searchParams.get('token'));
 assert.equal(first.title,'3D character editor');assert.equal(second.title,'3D character editor');assert.ok(button(a,'Editor'));assert.ok(button(b,'Editor'));
 await incoming('en');assert.equal(first.sent.length,0);assert.equal(second.sent.length,1);
 i.setLanguage('ru');assert.equal(first.sent.length,1,'local preference still broadcasts');assert.equal(second.sent.length,2);assert.equal(first.sent[0].data.language,'ru');
 assert.deepEqual(f.counts(),counts);assert.equal(JSON.stringify([a.properties,b.properties,a.widgets,b.widgets]),saved);a.onRemoved();b.onRemoved();
});

test('incoming bridge locale and init refresh presentation with zero language replies; local changes still send',async()=>{
 const f=fixture();f.bridgeDOM();const {connectEditor}=await f.load('editor-bridge.js'),i=await f.load('web/i18n.js');let sets=0,exports=0;
 const bridge=connectEditor({getState:state,setState(){sets++;},exportPNG(){exports++;}}),message=data=>f.emit('message',{origin,source:f.parent,data:{channel:'character-3d',token,...data}});
 await message({action:'language',language:'en'});assert.equal(f.sent.filter(m=>m.data.action==='language').length,0,'remote locale must not echo to parent');assert.equal(f.doc.querySelector('#freeze').textContent,'Freeze → node');assert.equal(sets,0);assert.equal(exports,0);
 await message({action:'init',state:state(),language:'ru'});assert.equal(f.sent.filter(m=>m.data.action==='language').length,0,'init language is remote too');assert.equal(sets,1);assert.equal(exports,0);
 await message({action:'language',language:'en'});assert.equal(f.sent.filter(m=>m.data.action==='language').length,0);assert.match(f.doc.querySelector('#status').textContent,/Draft opened/);
 i.setLanguage('ru');const replies=f.sent.filter(m=>m.data.action==='language');assert.equal(replies.length,1);assert.equal(replies[0].data.language,'ru');assert.equal(replies[0].origin,origin);assert.equal(replies[0].data.token,token);assert.equal(replies[0].data.channel,'character-3d');assert.equal(sets,1);assert.equal(exports,0);bridge.dispose();
});

test('backend package errors colliding with exact keys and dynamic patterns remain byte-identical across locale changes',async()=>{
 const f=fixture(),make=await f.cards(),node=make(),i=await f.load('web/i18n.js');i.setLanguage('en');const status=node._character3DCard.root.children.at(-2),counts=f.counts(),saved=JSON.stringify([node.properties,node.widgets]);
 const details=['Сброс','Экспорт пакета: HTTP 503','Некорректная кость head','Freeze не выполнен: Сброс','Exact backend: Имя {error}\nraw'];
 for(const detail of details){f.api.fetchApi=async()=>({ok:false,status:503,json:async()=>({error:detail})});await button(node,'ZIP package').click();assert.equal(status.textContent,detail,'initial EN display preserves backend provenance');i.setLanguage('ru');assert.equal(status.textContent,detail);i.setLanguage('en');assert.equal(status.textContent,detail);}
 // The same collision protection applies to import, not only export.
 f.api.fetchApi=async()=>({ok:false,status:503,json:async()=>({error:'Сброс'})});button(node,'Import ZIP').click();const picker=f.elements.at(-1);picker.files=[new Blob(['unit-test-only'])];picker.onchange();for(let attempts=0;node._character3DCard.freezeButton.disabled&&attempts<20;attempts++)await new Promise(resolve=>setImmediate(resolve));assert.equal(status.textContent,'Сброс');i.setLanguage('ru');assert.equal(status.textContent,'Сброс');i.setLanguage('en');assert.equal(status.textContent,'Сброс');
 assert.deepEqual(f.counts(),counts);assert.equal(JSON.stringify([node.properties,node.widgets]),saved);node.onRemoved();
});

test('locale copy refresh preserves all operational card flags, values and preview identity/src; operational handlers still update gates',async()=>{
 const f=fixture(),make=await f.cards(),node=make(),i=await f.load('web/i18n.js'),card=node._character3DCard;
 node.widgets[0].value='character_3d/c3d_0123456789abcdef0123456789abcdef.png';card.preview.src='http://qa.invalid/held-preview.png';
 const elements=[card.root,...f.elements.filter(e=>e!==card.root)],select=card.root.querySelector('select');
 elements.forEach((e,index)=>{e.disabled=index%2===0;e.hidden=index%3===0;e.checked=index%2===1;if(e!==select)e.value='held-'+index;});card.preview.hidden=true;card.freezeButton.disabled=true;card.exportButton.disabled=true;card.packageButtons[0].disabled=false;card.packageButtons[1].disabled=true;
 const snapshot=()=>elements.map(e=>({element:e,disabled:e.disabled,hidden:e.hidden,checked:e.checked,value:e===select?'locale':e.value,src:e.getAttribute('src'),display:e.style.display})),before=snapshot(),saved=JSON.stringify([node.properties,node.widgets]),counts=f.counts();
 i.setLanguage('en');assert.deepEqual(snapshot(),before,'locale must not recalculate existing operation gates/visibility');assert.equal(card.preview,node._character3DCard.preview);assert.equal(card.status.textContent,'Frozen · IMAGE ready');i.setLanguage('ru');assert.deepEqual(snapshot(),before);assert.equal(JSON.stringify([node.properties,node.widgets]),saved);assert.deepEqual(f.counts(),counts);
 // Existing configure/package paths remain operational and intentionally recalculate gates.
 node.onConfigure();await new Promise(resolve=>queueMicrotask(resolve));assert.equal(card.freezeButton.disabled,false);assert.equal(card.exportButton.disabled,false);assert.equal(card.preview.hidden,false);assert.notEqual(card.preview.src,'http://qa.invalid/held-preview.png');assert.ok(card.packageButtons.every(b=>!b.disabled));
 let resolveRequest;f.api.fetchApi=()=>new Promise(resolve=>{resolveRequest=resolve;});const action=button(node,'Пакет ZIP').click();assert.equal(card.freezeButton.disabled,true);assert.ok(card.packageButtons.every(b=>b.disabled));i.setLanguage('en');assert.equal(card.freezeButton.disabled,true);resolveRequest({ok:false,status:500,json:async()=>{throw Error('no JSON');}});await action;assert.equal(card.freezeButton.disabled,false);assert.ok(card.packageButtons.every(b=>!b.disabled));node.onRemoved();
});

// Second-cycle source regressions: authenticated text is not local copy merely
// because it collides with a catalog key/template. No source mutation probes.
const collisionDetails=['Сброс','Некорректная кость head','Freeze не выполнен: Сброс','Freeze не выполнен: {error}','Exact backend: Имя {error}\nraw'];
for(const detail of collisionDetails)test(`second-cycle Freeze-result literal collision: ${detail}`,async()=>{
 const f=fixture();f.bridgeDOM();const {connectEditor}=await f.load('editor-bridge.js'),i=await f.load('web/i18n.js');i.setLanguage('en');
 const bridge=connectEditor({getState:state,setState(){},exportPNG:async()=>new Blob(['CPU fixture'],{type:'image/png'})}),message=data=>f.emit('message',{origin,source:f.parent,data:{channel:'character-3d',token,...data}});
 try{await message({action:'init',state:state(),language:'en'});await bridge.freeze();const request=f.sent.find(m=>m.data.action==='freeze').data;
 await message({action:'freeze-result',requestId:request.requestId,error:detail});assert.equal(f.doc.querySelector('#status').textContent,'Freeze failed: '+detail,'initial EN detail must be literal');i.setLanguage('ru');assert.equal(f.doc.querySelector('#status').textContent,'Freeze не выполнен: '+detail);i.setLanguage('en');assert.equal(f.doc.querySelector('#status').textContent,'Freeze failed: '+detail);}finally{bridge.dispose();}
});
for(const detail of collisionDetails)test(`second-cycle remote card literal collision: ${detail}`,async()=>{
 const f=fixture(),make=await f.cards(),node=make(),i=await f.load('web/i18n.js');i.setLanguage('en');button(node,'Editor').click();const iframe=f.elements.find(e=>e.tagName==='IFRAME'),auth={channel:'character-3d',token:new URL(iframe.src).searchParams.get('token'),action:'error',error:detail},counts=f.counts(),saved=JSON.stringify([node.properties,node.widgets]);
 try{await f.emit('message',{origin,source:iframe.contentWindow,data:auth});assert.equal(node._character3DCard.status.textContent,detail,'initial EN remote error must be literal');i.setLanguage('ru');assert.equal(node._character3DCard.status.textContent,detail);i.setLanguage('en');assert.equal(node._character3DCard.status.textContent,detail);assert.deepEqual(f.counts(),counts);assert.equal(JSON.stringify([node.properties,node.widgets]),saved);}finally{node.onRemoved();}
});
for(const operation of ['freeze','export'])test(`second-cycle ${operation} caught transport collision stays literal`,async()=>{
 const f=fixture(),make=await f.cards(),node=make(),i=await f.load('web/i18n.js');i.setLanguage('en');button(node,'Editor').click();const iframe=f.elements.find(e=>e.tagName==='IFRAME'),auth={channel:'character-3d',token:new URL(iframe.src).searchParams.get('token')};
 const pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZ0AAAAASUVORK5CYII=','base64');
 try{for(const detail of collisionDetails){f.api.fetchApi=async()=>{throw Error(detail);};if(operation==='freeze')await f.emit('message',{origin,source:iframe.contentWindow,data:{...auth,action:'freeze',requestId:'transport',state:state(),png:new Blob([pngBytes],{type:'image/png'})}});else{node.widgets[0].value='character_3d/transport.png';node.onConfigure();await new Promise(resolve=>queueMicrotask(resolve));await button(node,'Export PNG').click();}
 assert.equal(node._character3DCard.status.textContent,detail);if(operation==='freeze'){assert.equal(iframe.sent.at(-1).data.error,detail);assert.equal(iframe.sent.at(-1).data.errorSource,undefined);assert.equal(node.widgets[0].value,'');assert.equal(node.widgets[1].value,'');}i.setLanguage('ru');assert.equal(node._character3DCard.status.textContent,detail);i.setLanguage('en');assert.equal(node._character3DCard.status.textContent,detail);}}finally{node.onRemoved();}
});
test('second-cycle local validation provenance follows Freeze-result while bare editor capture errors stay literal',async()=>{
 const p=fixture(),make=await p.cards(),node=make(),pi=await p.load('web/i18n.js');pi.setLanguage('en');button(node,'Editor').click();const iframe=p.elements.find(e=>e.tagName==='IFRAME'),auth={channel:'character-3d',token:new URL(iframe.src).searchParams.get('token')};
 const c=fixture();c.bridgeDOM();const ci=await c.load('web/i18n.js'),{connectEditor}=await c.load('editor-bridge.js');let exportError=null;
 const bridge=connectEditor({getState:state,setState(){},exportPNG:async()=>{if(exportError)throw exportError;return new Blob(['CPU fixture'],{type:'image/png'});}}),message=data=>c.emit('message',{origin,source:c.parent,data:{channel:'character-3d',token,...data}});
 try{await p.emit('message',{origin,source:iframe.contentWindow,data:{...auth,action:'freeze',requestId:'local',state:{...state(),pose:{head:[1]}}}});const result=iframe.sent.at(-1).data;assert.equal(result.error,'Некорректная кость head');assert.equal(result.errorSource,'Некорректная кость head');assert.equal(node._character3DCard.status.textContent,'Invalid bone head');pi.setLanguage('ru');assert.equal(node._character3DCard.status.textContent,result.error);pi.setLanguage('en');assert.equal(node._character3DCard.status.textContent,'Invalid bone head');
 await message({action:'init',state:state(),language:'en'});await bridge.freeze();let request=c.sent.filter(m=>m.data.action==='freeze').at(-1).data;await message({action:result.action,error:result.error,errorSource:result.errorSource,requestId:request.requestId});assert.equal(c.doc.querySelector('#status').textContent,'Freeze failed: Invalid bone head');ci.setLanguage('ru');assert.equal(c.doc.querySelector('#status').textContent,'Freeze не выполнен: Некорректная кость head');ci.setLanguage('en');assert.equal(c.doc.querySelector('#status').textContent,'Freeze failed: Invalid bone head');
 for(const detail of collisionDetails){exportError=Error(detail);await bridge.freeze();assert.equal(c.doc.querySelector('#status').textContent,detail);const error=c.sent.filter(m=>m.data.action==='error').at(-1).data;assert.equal(error.error,detail);assert.equal(error.errorSource,undefined);ci.setLanguage('ru');assert.equal(c.doc.querySelector('#status').textContent,detail);ci.setLanguage('en');assert.equal(c.doc.querySelector('#status').textContent,detail);}
 exportError=Object.assign(Error('PNG превышает допустимое разрешение.'),{i18nSource:'PNG превышает допустимое разрешение.'});await bridge.freeze();assert.equal(c.doc.querySelector('#status').textContent,'PNG exceeds the allowed resolution.');ci.setLanguage('ru');assert.equal(c.doc.querySelector('#status').textContent,'PNG превышает допустимое разрешение.');
 }finally{bridge.dispose();node.onRemoved();}
});

test('second-cycle Freeze authentication and PNG/readback failures never publish a partial pair',async()=>{
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZ0AAAAASUVORK5CYII=','base64'),f=fixture(),make=await f.cards(),node=make(),i=await f.load('web/i18n.js');i.setLanguage('en');button(node,'Editor').click();const iframe=f.elements.find(e=>e.tagName==='IFRAME'),auth={channel:'character-3d',token:new URL(iframe.src).searchParams.get('token')},send=(data,extra={})=>f.emit('message',{origin,source:iframe.contentWindow,data:{...auth,...data},...extra});
 const saved=JSON.stringify(node.widgets.map(w=>w.value)),counts=f.counts();let network=0,callbacks=0;for(const w of node.widgets)w.callback=()=>callbacks++;f.api.fetchApi=async()=>{network++;throw Error('must not run');};
 try{const request={...auth,action:'freeze',requestId:'unauthorized',state:state(),png:new Blob([bytes],{type:'image/png'})};for(const extra of [{origin:'https://evil.invalid'},{source:{}},{data:{...request,channel:'other'}},{data:{...request,token:'bad'}}]){await f.emit('message',{origin,source:iframe.contentWindow,data:request,...extra});assert.equal(network,0);assert.equal(node._character3DBusy,undefined);assert.equal(JSON.stringify(node.widgets.map(w=>w.value)),saved);}
 const path={type:'input',subfolder:'character_3d',name:'c3d_0123456789abcdef0123456789abcdef.png'},wide=Buffer.from(bytes);wide.writeUInt32BE(4097,16);
 const cases=[
  {png:new Blob([bytes],{type:'text/plain'}),detail:'Редактор не передал PNG.',en:'The editor did not provide a PNG.'},
  {png:new Blob(['not PNG'],{type:'image/png'}),detail:'Freeze ожидает PNG до 16 MiB.'},
  {png:new Blob([wide],{type:'image/png'}),detail:'PNG превышает допустимое разрешение.',en:'PNG exceeds the allowed resolution.'},
  {upload:{ok:false,status:503},detail:'Загрузка PNG: HTTP 503',en:'PNG upload: HTTP 503'},
  {upload:{ok:true,json:async()=>({...path,subfolder:'other'})},detail:'Сервер вернул неожиданный путь PNG.'},
  {readback:{ok:false},detail:'Сохранённый PNG недоступен.'},
  {readback:{ok:true,arrayBuffer:async()=>new ArrayBuffer(1)},detail:'Сохранённый PNG отличается от отправленного.'},
 ];
 for(const scenario of cases){network=0;f.api.fetchApi=async route=>{network++;return route==='/upload/image'?(scenario.upload||{ok:true,json:async()=>path}):(scenario.readback||{ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});};await send({action:'freeze',requestId:'reject',state:state(),png:scenario.png||new Blob([bytes],{type:'image/png'})});const reply=iframe.sent.at(-1).data;assert.equal(reply.error,scenario.detail);assert.equal(reply.errorSource,scenario.detail);assert.equal(node._character3DBusy,false);assert.equal(JSON.stringify(node.widgets.map(w=>w.value)),saved);assert.equal(callbacks,0);assert.deepEqual(f.counts(),counts);if(scenario.png)assert.equal(network,0);if(scenario.en)assert.equal(node._character3DCard.status.textContent,scenario.en);i.setLanguage('ru');assert.equal(node._character3DCard.status.textContent,scenario.detail);i.setLanguage('en');}
 }finally{node.onRemoved();}
});

test('schema errors stay canonical while presentation translates dynamic field/bone/scene paths',async()=>{
 const f=fixture(),s=await f.load('web/state.js'),i=await f.load('web/i18n.js');i.setLanguage('en');
 assert.throws(()=>s.normalizeState({schema:'bad'}),e=>e.message==='Неизвестная схема персонажа.'&&i.t(e.message)==='Unknown character schema.');
 assert.equal(i.t('Некорректная кость head'),'Invalid bone head');assert.equal(i.t('Некорректная сцена: камера.zoom: требуется положительное число'),'Invalid scene: camera.zoom: a positive number is required');assert.equal(i.t('Некорректная сцена: actors[0].state: требуется объект'),'Invalid scene: actors[0].state: an object is required');
 assert.equal((await f.load('i18n.js')).setLanguage,i.setLanguage);
});

test('node dictionary covers every Russian literal in owned UI/bridge/package sources except assembled HTTP prefixes',async()=>{
 const f=fixture(),i=await f.load('web/i18n.js');i.setLanguage('en');
 for(const file of ['web/extension.js','web/package.js','editor-bridge.js']){const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');for(const match of source.matchAll(/'((?:[^'\\]|\\.)*)'/g)){let text=match[1];if(!/[А-Яа-яЁё]/.test(text))continue;text=text.replace(/\\n/g,'\n');if(text.endsWith('HTTP '))text+='500';assert.notEqual(i.t(text),text,`${file}: ${text}`);}}
});
