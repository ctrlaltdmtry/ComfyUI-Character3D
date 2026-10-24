import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {getLanguage,setLanguage,isLanguage,t,onLanguageChange,bindText,bindAttr,localizeDOM,createLanguageControl,LANGUAGE_KEY} from '../web/i18n.js';

class Element {
 constructor(tag='span') { this.tagName=tag.toUpperCase(); this.children=[]; this.textContent=''; this.value='kept'; this.checked=true; this.disabled=true; this.style={}; this.attributes=new Map(); this.handlers=new Map(); }
 setAttribute(k,v){this.attributes.set(k,String(v));}
 getAttribute(k){return this.attributes.get(k)??null;}
 hasAttribute(k){return this.attributes.has(k);}
 append(...nodes){this.children.push(...nodes);}
 addEventListener(k,fn){if(!this.handlers.has(k))this.handlers.set(k,new Set());this.handlers.get(k).add(fn);}
 removeEventListener(k,fn){this.handlers.get(k)?.delete(fn);}
 dispatch(k){for(const fn of this.handlers.get(k)||[])fn({target:this});}
}
const reset=()=>setLanguage('ru',{persist:false});

test('strict supported locales and no mutation from invalid values',()=>{
 reset(); assert.equal(getLanguage(),'ru');
 for(const value of ['fr','EN','ru-RU','',null,undefined,{},1]){
  assert.equal(isLanguage(value),false); assert.throws(()=>setLanguage(value),TypeError); assert.equal(getLanguage(),'ru');
 }
 assert.equal(isLanguage('en'),true);assert.equal(isLanguage('ru'),true);
});
test('Russian defaults, exact English text and unknown details remain literal',()=>{
 reset();assert.equal(t('Сброс'),'Сброс');setLanguage('en',{persist:false});assert.equal(t('Сброс'),'Reset');
 assert.equal(t('HTTP 418: user authored Андрей <text>'),'HTTP 418: user authored Андрей <text>');reset();
});
test('named interpolation and dynamic assembled templates',()=>{
 reset();assert.equal(t('{visible} / {count} параметров',{visible:7,count:68}),'7 / 68 параметров');
 setLanguage('en',{persist:false});assert.equal(t('{visible} / {count} параметров',{visible:7,count:68}),'7 / 68 parameters');
 assert.equal(t('7 / 68 параметров'),'7 / 68 parameters');assert.equal(t('{label} · точное значение',{label:'Face'}),'Face · exact value');
 assert.equal(t('Face · точное значение'),'Face · exact value');reset();
});
test('invalid translation inputs rejected without evaluating markup',()=>{
 reset();assert.throws(()=>t({}),TypeError);assert.throws(()=>t('Сброс',[]),TypeError);assert.throws(()=>t('Сброс',null),TypeError);
 assert.equal(t('literal <img onerror=alert(1)>'),'literal <img onerror=alert(1)>');
});
test('leaf weak text binding switches in place and unbind preserves last text',()=>{
 reset();const node=new Element();const ref=node;const off=bindText(node,'Сброс');assert.equal(node.textContent,'Сброс');
 setLanguage('en',{persist:false});assert.equal(node,ref);assert.equal(node.textContent,'Reset');
 assert.equal(node.value,'kept');assert.equal(node.checked,true);assert.equal(node.disabled,true);
 off();reset();assert.equal(node.textContent,'Reset');
});
test('mixed control text binding rejected before children or values change',()=>{
 reset();const label=new Element('label'),input=new Element('input');label.append(input);label.textContent='Ширина';
 assert.throws(()=>bindText(label,'Камера'),/leaf/);assert.equal(label.children[0],input);assert.equal(input.value,'kept');
});
test('dynamic getter updates with locale without changing model data',()=>{
 reset();const state={value:7},node=new Element();const before=JSON.stringify(state);
 const off=bindText(node,'{visible} / {count} параметров',()=>({visible:state.value,count:68}));
 setLanguage('en',{persist:false});assert.equal(node.textContent,'7 / 68 parameters');assert.equal(JSON.stringify(state),before);off();reset();
});
test('presentation-only attributes refresh; value/id bindings forbidden',()=>{
 reset();const node=new Element('input');const off=bindAttr(node,'aria-label','Язык интерфейса');
 setLanguage('en',{persist:false});assert.equal(node.getAttribute('aria-label'),'Interface language');assert.equal(node.value,'kept');
 for(const attr of ['value','id','src','data-state','onclick'])assert.throws(()=>bindAttr(node,attr,'Сброс'),TypeError);
 off();reset();
});
test('callbacks idempotent and removable; no scene/graph event plumbing',()=>{
 reset();const observed=[];const off=onLanguageChange(next=>observed.push(next));
 assert.equal(setLanguage('en',{persist:false}),true);assert.equal(setLanguage('en',{persist:false}),false);
 assert.deepEqual(observed,['en']);off();reset();assert.deepEqual(observed,['en']);assert.throws(()=>onLanguageChange(null),TypeError);
});
test('explicit DOM annotations only; authored text not globally translated',()=>{
 reset();const marked=new Element(),user=new Element();marked.setAttribute('data-i18n','Сброс');user.textContent='Сброс';
 const root={querySelectorAll:()=>[marked]};const off=localizeDOM(root);
 setLanguage('en',{persist:false});assert.equal(marked.textContent,'Reset');assert.equal(user.textContent,'Сброс');off();reset();
});
test('selector synchronizes, switches natively and disposal removes callbacks',()=>{
 reset();const doc={createElement:tag=>new Element(tag)};const picker=createLanguageControl({document:doc,id:'ui-language'});
 assert.equal(picker.select.id,'ui-language');assert.equal(picker.select.value,'ru');assert.equal(picker.select.children.length,2);
 picker.select.value='en';picker.select.dispatch('change');assert.equal(getLanguage(),'en');assert.equal(picker.select.getAttribute('aria-label'),'Interface language');
 reset();assert.equal(picker.select.value,'ru');picker.dispose();picker.dispose();setLanguage('en',{persist:false});assert.equal(picker.select.value,'ru');reset();
});

const moduleURL=new URL('../web/i18n.js',import.meta.url).href;
const probe=body=>{const r=spawnSync(process.execPath,['--input-type=module','-e',body],{encoding:'utf8',cwd:fileURLToPath(new URL('..',import.meta.url)),timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
test('opaque storage get/set throws but default and language switching work',()=>{
 const r=probe(`Object.defineProperty(globalThis,'localStorage',{get(){throw new Error('opaque origin');}});const m=await import(${JSON.stringify(moduleURL)});const before=m.getLanguage();m.setLanguage('en');console.log(JSON.stringify({before,after:m.getLanguage(),text:m.t('Сброс')}));`);
 assert.deepEqual(r,{before:'ru',after:'en',text:'Reset'});
});
test('valid stored preference, invalid stored preference and query precedence',()=>{
 for(const [stored,search,expected] of [['en','','en'],['xx','','ru'],['en','?lang=ru','ru'],['ru','?lang=en','en'],['en','?lang=xx','en']]){
  const r=probe(`globalThis.localStorage={getItem:k=>${JSON.stringify(stored)}};globalThis.location={search:${JSON.stringify(search)}};const m=await import(${JSON.stringify(moduleURL)});console.log(JSON.stringify(m.getLanguage()));`);assert.equal(r,expected);
 }
});
test('same-origin storage events accept only the preference key and strict locales',()=>{
 const r=probe(`let handler;globalThis.addEventListener=(kind,fn)=>{if(kind==='storage')handler=fn};const m=await import(${JSON.stringify(moduleURL)});handler({key:'foreign',newValue:'en'});const a=m.getLanguage();handler({key:${JSON.stringify(LANGUAGE_KEY)},newValue:'en'});const b=m.getLanguage();handler({key:${JSON.stringify(LANGUAGE_KEY)},newValue:'xx'});console.log(JSON.stringify([a,b,m.getLanguage()]));`);
 assert.deepEqual(r,['ru','en','en']);
});
