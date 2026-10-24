// Minimal CPU DOM/event surface; no browser, server, canvas context or renderer.
export class Element {
 constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.parentNode=null;this.attributes=new Map();this.handlers=new Map();this.style={};this._text='';this._value=undefined;this.hidden=false;this.checked=false;this.disabled=false;this.open=false;this.classes=new Set();
 this.dataset=new Proxy({}, {set:(obj,k,v)=>{obj[k]=String(v);this.attributes.set('data-'+k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),String(v));return true;}});
 this.classList={toggle:(k,on)=>{on??=!this.classes.has(k);on?this.classes.add(k):this.classes.delete(k);return on;},add:k=>this.classes.add(k),remove:k=>this.classes.delete(k),contains:k=>this.classes.has(k)};}
 get id(){return this.getAttribute('id')||'';}set id(v){this.setAttribute('id',v);}
 get title(){return this.getAttribute('title')||'';}set title(v){this.setAttribute('title',v);}
 get className(){return [...this.classes].join(' ');}set className(v){this.classes=new Set(v.split(/\s+/).filter(Boolean));}
 get value(){return this._value??(this.tagName==='SELECT'?this.children[0]?.value??'':'');}set value(v){this._value=String(v);}
 get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}set textContent(v){this._text=String(v);this.replaceChildren();}
 setAttribute(k,v){this.attributes.set(k,String(v));if(k==='class')this.className=v;if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v);}
 getAttribute(k){return this.attributes.get(k)??null;}hasAttribute(k){return this.attributes.has(k);}
 append(...nodes){for(const n of nodes){n.remove();n.parentNode=this;this.children.push(n);}}
 replaceChildren(...nodes){for(const n of this.children)n.parentNode=null;this.children=[];this.append(...nodes);}
 remove(){if(this.parentNode){const a=this.parentNode.children;a.splice(a.indexOf(this),1);this.parentNode=null;}}
 insertBefore(n,ref){n.remove();n.parentNode=this;this.children.splice(ref?this.children.indexOf(ref):this.children.length,0,n);}
 after(n){this.parentNode.insertBefore(n,this.parentNode.children[this.parentNode.children.indexOf(this)+1]??null);}
 before(n){this.parentNode.insertBefore(n,this);}closest(s){for(let n=this;n;n=n.parentNode)if(n.matches(s))return n;return null;}
 addEventListener(k,fn){if(!this.handlers.has(k))this.handlers.set(k,new Set());this.handlers.get(k).add(fn);}
 removeEventListener(k,fn){this.handlers.get(k)?.delete(fn);}
 fire(k='change',extra={}){const e={target:this,preventDefault(){},stopPropagation(){},...extra};for(const fn of this.handlers.get(k)||[])fn(e);this['on'+k]?.(e);}
 focus(){this.ownerDocument.activeElement=this;}blur(){this.ownerDocument.activeElement=null;}scrollIntoView(){}setPointerCapture(){}
 matches(selector){return selector.split(',').some(s=>{s=s.trim();if(s==='*')return true;if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return this.classes.has(s.slice(1));const m=/^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(s);if(m)return (!m[1]||this.tagName===m[1].toUpperCase())&&this.hasAttribute(m[2])&&(m[3]===undefined||this.getAttribute(m[2])===m[3]);return this.tagName===s.toUpperCase();});}
 querySelectorAll(s){const out=[];for(const n of this.children){if(n.matches(s))out.push(n);out.push(...n.querySelectorAll(s));}return out;}
 querySelector(s){return this.querySelectorAll(s)[0]??null;}
 set innerHTML(html){this.replaceChildren();this._text='';const stack=[this];for(const token of html.match(/<[^>]*>|[^<]+/g)||[]){if(token.startsWith('<!'))continue;if(token.startsWith('</')){stack.pop();continue;}if(token.startsWith('<')){const tag=/^<(\w+)/.exec(token)?.[1];if(!tag)continue;const node=this.ownerDocument.createElement(tag);for(const [,k,v='']of token.slice(tag.length+1,-1).matchAll(/([^\s=]+)(?:="([^"]*)")?/g)){node.setAttribute(k,v);if(['value','type','min','max','step'].includes(k))node[k]=v;if(['hidden','disabled','checked','open'].includes(k))node[k]=true;}stack.at(-1).append(node);if(!['input','link','meta','br','hr'].includes(tag))stack.push(node);}else stack.at(-1)._text+=token;}}
}
export class Document {
 constructor(){this.body=new Element('body',this);this.documentElement=new Element('html',this);this.activeElement=null;}
 createElement(tag){return new Element(tag,this);}
 getElementById(id){return this.body.querySelector('#'+id);}
 querySelector(s){return this.body.querySelector(s);}
 querySelectorAll(s){return this.body.querySelectorAll(s);}
}
