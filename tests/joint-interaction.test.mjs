// Labelled minimal DOM/EventTarget harness; actual camera/matrices and production pointer adapter.
import assert from 'node:assert/strict';import {OrthographicCamera} from '../vendor/three.module.js';import {attachJointPicker} from '../joint-interaction.js';
const originalDocument=globalThis.document,markers=[];globalThis.document={createElement:()=>{const e={style:{},hidden:true,setAttribute(){},remove(){this.removed=true;}};markers.push(e);return e;}};
const canvas=new EventTarget();canvas.getBoundingClientRect=()=>({left:0,top:0,width:400,height:400});const viewport={clientWidth:400,clientHeight:400,append(){}};
const camera=new OrthographicCamera(-2,2,2,-2,.01,100);camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
let selected=[],active=true,sheet=false,busy=false;const rig={jointRecords:()=>[{id:'a',category:'body',position:[0,0,0]},{id:'overlap',category:'body',position:[0,0,0]}],pickCategories:()=>['body'],pointerBusy:()=>busy,select:i=>selected.push(i)};
const picker=attachJointPicker({viewport,canvas,camera,rig,enabled:()=>active,isSheet:()=>sheet,onSelect(){}});
function event(type,x=200,y=200,props={}){const e=new Event(type);Object.assign(e,{pointerId:1,clientX:x,clientY:y,button:0,isPrimary:true,getCoalescedEvents:()=>[],...props});canvas.dispatchEvent(e);}
function click(x=200,y=200){event('pointerdown',x,y);event('pointerup',x,y);}
try{
 click();assert.deepEqual(selected,[0]);click();assert.deepEqual(selected,[0,1]);
 const n=selected.length;event('pointerdown');event('pointermove',300,200);event('pointermove',200,200);event('pointerup');assert.equal(selected.length,n,'empty coalesced array cannot lose drag history');
 event('pointerdown');event('pointercancel');event('pointerup');assert.equal(selected.length,n);
 click(5,5);assert.equal(selected.length,n,'empty click no far selection');
 sheet=true;click();assert.equal(selected.length,n);sheet=false;busy=true;click();assert.equal(selected.length,n);busy=false;active=false;click();assert.equal(selected.length,n);active=true;
 event('pointerdown',200,200,{button:2});event('pointerup',200,200,{button:2});assert.equal(selected.length,n);
 picker.dispose();assert.ok(markers[0].removed);click();assert.equal(selected.length,n,'listeners disposed');
 console.log('PASS production pointer adapter: click/cycle, empty coalesced drag-return, cancel, empty area, sheet/gizmo/disabled/right-button guards, listener cleanup. DOM harness, no browser/GPU.');
}finally{globalThis.document=originalDocument;}
