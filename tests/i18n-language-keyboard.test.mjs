import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../web/i18n.js';
import {Document} from './i18n-editor-dom.mjs';
const viewer=await readFile(new URL('../viewer.js',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const start=viewer.indexOf('function attachEditorLanguageUI('),end=viewer.indexOf('const editorLanguage=',start);
assert.ok(start>=0&&end>start);
const adapterSource=viewer.slice(start,end);
const disposers=[];
afterEach(()=>{for(const dispose of disposers.splice(0))dispose();core.setLanguage('ru',{persist:false});delete globalThis.document;});
function verifyKeys(select,dispose){
 const value=select.value,keys=['Home','ArrowDown','ArrowUp','Enter','Escape','Tab',' '];
 let stops=0,prevented=0;
 for(const type of ['keydown','keyup'])for(const key of keys){
  const before=stops;
  select.fire(type,{key,stopPropagation(){stops++;},preventDefault(){prevented++;}});
  assert.equal(stops,before+1,`${type} ${key}: must not reach graph/model global shortcuts`);
  assert.equal(select.value,value,'Isolation must not assign a native option value');
 }
 assert.equal(prevented,0,'Native selection, focus navigation and popup dismissal remain browser defaults');
 const before=stops;dispose();dispose();
 for(const type of ['keydown','keyup'])select.fire(type,{key:'Enter',stopPropagation(){stops++;},preventDefault(){prevented++;}});
 assert.equal(stops,before,'Disposed selector must release key listeners');
 assert.equal(prevented,0);
}
test('node language selector contains global graph keyboard events without cancelling native defaults',()=>{
 core.setLanguage('ru',{persist:false});const doc=new Document(),ui=core.createLanguageControl({document:doc,compact:true});
 disposers.push(()=>ui.dispose());verifyKeys(ui.select,()=>ui.dispose());
});
test('editor language selector contains rig/global keyboard events without cancelling native defaults',()=>{
 core.setLanguage('ru',{persist:false});const doc=new Document();doc.body.innerHTML=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g,'');
 globalThis.document=doc;const ui=vm.runInNewContext(adapterSource+';attachEditorLanguageUI(document)',{...core,document:doc});
 disposers.push(()=>ui.dispose());verifyKeys(doc.getElementById('ui-language'),()=>ui.dispose());
});

// Model the browser capture order: window -> document (LiteGraph) -> select.
class CaptureWindow {
 constructor(){this.handlers=new Map();}
 addEventListener(type,fn,capture=false){if(!this.handlers.has(type))this.handlers.set(type,[]);this.handlers.get(type).push({fn,capture:!!capture});}
 removeEventListener(type,fn,capture=false){const rows=this.handlers.get(type)||[];this.handlers.set(type,rows.filter(r=>r.fn!==fn||r.capture!==!!capture));}
 capture(type,event){for(const row of this.handlers.get(type)||[])if(row.capture)row.fn(event);}
}
function browserKey(doc,select,type,key,target=select,composedPath){
 let stopped=false,prevented=false,graphCalls=0;
 const event={target,key,composedPath:()=>composedPath||(target===select?[select,doc,doc.defaultView]:[target,doc,doc.defaultView]),stopPropagation(){stopped=true;},preventDefault(){prevented=true;}};
 doc.defaultView.capture(type,event);
 if(!stopped){graphCalls++;if(target===select)select.fire(type,event);}
 return {graphCalls,prevented};
}
for(const mode of ['node','editor'])test(`${mode} keyboard containment runs before document capture and ignores unrelated controls`,()=>{
 core.setLanguage('ru',{persist:false});const doc=new Document();doc.defaultView=new CaptureWindow();let ui,select;
 if(mode==='node'){ui=core.createLanguageControl({document:doc,compact:true});select=ui.select;}
 else{doc.body.innerHTML=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g,'');globalThis.document=doc;ui=vm.runInNewContext(adapterSource+';attachEditorLanguageUI(document)',{...core,document:doc});select=doc.getElementById('ui-language');}
 disposers.push(()=>ui.dispose());const other=doc.createElement('input'),value=select.value;
 for(const type of ['keydown','keyup'])for(const key of ['Home','ArrowDown','Enter','Escape','Tab']){
  assert.deepEqual(browserKey(doc,select,type,key),{graphCalls:0,prevented:false},`${mode}: ${type} ${key} must precede document capture`);
  assert.deepEqual(browserKey(doc,select,type,key,other),{graphCalls:1,prevented:false},'Other controls/global shortcuts must be untouched');
  assert.deepEqual(browserKey(doc,select,type,key,other,[other,select,doc,doc.defaultView]),{graphCalls:0,prevented:false},'Retargeted events containing this select in composedPath must be contained');
 }
 assert.equal(select.value,value);select.value='en';select.fire('change');assert.equal(core.getLanguage(),'en','Native change remains available');
 ui.dispose();ui.dispose();
 for(const type of ['keydown','keyup']){
  assert.deepEqual(browserKey(doc,select,type,'Enter'),{graphCalls:1,prevented:false},'Window capture listener must be removed on disposal');
  assert.deepEqual(browserKey(doc,select,type,'Enter',other,[other,select,doc,doc.defaultView]),{graphCalls:1,prevented:false},'Disposed retargeted-event listeners must also be absent');
 }
});
