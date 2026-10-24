// CPU-only narrow DOM + actual production modules. No server/browser/renderer.
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
export class Element {
 constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.parentNode=null;this.style={};this.dataset={};this.attrs=new Map();this.listeners=new Map();this.disabled=false;this.hidden=false;this._text='';this.classList={toggle(){}};this.value='';this.onclick=null;}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}set textContent(v){this._text=String(v);this.children=[];}
 append(...nodes){for(const n of nodes){n.remove();n.parentNode=this;this.children.push(n);}}
 remove(){if(this.parentNode){this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;}}
 setAttribute(k,v){this.attrs.set(k,String(v));}getAttribute(k){return this.attrs.get(k)??null;}
 addEventListener(k,fn){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(fn);}removeEventListener(k,fn){this.listeners.get(k)?.delete(fn);}
 dispatch(k,event={}){for(const fn of this.listeners.get(k)||[])fn({target:this,...event});}
 click(){if(this.disabled)return;this.dispatch('click');return this.onclick?.({target:this});}
 focus(){}showModal(){}querySelector(selector){return walk(this).find(e=>matches(e,selector))||null;}
 set src(v){this.setAttribute('src',v);}get src(){return this.getAttribute('src');}
}
const walk=root=>[root,...root.children.flatMap(walk)];
const matches=(e,s)=>s.startsWith('#')?e.id===s.slice(1):s.startsWith('.')?e.className===s.slice(1):e.tagName===s.toUpperCase();
export function fixture(){
 const elements=[],body=new Element('body'),doc={body,documentElement:new Element('html'),createElement(tag){const e=new Element(tag,doc);elements.push(e);if(tag==='iframe'){e.sent=[];e.contentWindow={postMessage:(data,origin)=>e.sent.push({data,origin})};}return e;},querySelector(s){return walk(body).find(e=>matches(e,s))||null;},querySelectorAll(s){return walk(body).filter(e=>s.split(',').some(part=>matches(e,part)));}};
 const handlers=new Map(),sent=[],stored=new Map();let extension,graphChanges=0,dirty=0,loaded=[];
 const app={graph:{_nodes:[],change(){graphChanges++;},serialize(){return {nodes:[],extra:{authored:'Имя'}};}},registerExtension(e){extension=e;},async loadGraphData(data){loaded.push(data);}};
 const api={apiURL:s=>s,fetchApi:async()=>{throw Error('Unexpected network request');}};
 const parent={postMessage:(data,origin)=>sent.push({data,origin})};
 const globals={console,URL,URLSearchParams,TextEncoder,TextDecoder,ArrayBuffer,Uint8Array,DataView,Blob,FormData,crypto:webcrypto,setTimeout,clearTimeout,queueMicrotask,document:doc,location:{origin:'http://qa.invalid',href:'http://qa.invalid/',search:'?token=0123456789abcdef0123456789abcdef'},parent,app,api,localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},addEventListener:(k,fn)=>{if(!handlers.has(k))handlers.set(k,new Set());handlers.get(k).add(fn);},removeEventListener:(k,fn)=>handlers.get(k)?.delete(fn),confirm:()=>true,alert:()=>{}};
 globals.window=globals;globals.window.parent=parent;
 const context=vm.createContext(globals),cache=new Map();
 const base=new URL('../',import.meta.url);
 function get(url){if(cache.has(url.href))return cache.get(url.href);let text;
  if(url.pathname.endsWith('/scripts/app.js'))text='export const app=globalThis.app;';
  else if(url.pathname.endsWith('/scripts/api.js'))text='export const api=globalThis.api;';
  else text=fs.readFileSync(fileURLToPath(url),'utf8');
  const m=new vm.SourceTextModule(text,{context,identifier:url.href});cache.set(url.href,m);return m;
 }
 async function load(name){const m=get(new URL(name,base));if(m.status==='unlinked')await m.link((spec,from)=>get(new URL(spec,from.identifier)));if(m.status==='linked')await m.evaluate();return m.namespace;}
 async function cards(){await load('web/extension.js');class Node{constructor(){this.properties={authored:'Русское имя'};this.widgets=[{name:'snapshot',value:''},{name:'scene_json',value:''}];}addDOMWidget(...args){this.domWidget=args;}setSize(){}setDirtyCanvas(){dirty++;}}
  await extension.beforeRegisterNodeDef(Node,{name:'Character3DEditor'});return ()=>{const node=new Node();app.graph._nodes.push(node);node.onNodeCreated();return node;};
 }
 function bridgeDOM(){for(const id of ['freeze','close-editor','status']){const e=doc.createElement(id==='status'?'div':'button');e.id=id;body.append(e);}const tag=doc.createElement('span');tag.className='tag';body.append(tag);}
 function emit(type,event){return Promise.all([...handlers.get(type)||[]].map(fn=>fn(event)));}
 return {doc,elements,context,globals,app,api,parent,sent,stored,load,cards,bridgeDOM,emit,handlers,counts:()=>({graphChanges,dirty,loaded:loaded.length}),loaded};
}
