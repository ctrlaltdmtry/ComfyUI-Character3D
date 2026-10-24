// DOM/pointer adapter for the CPU-only picking engine. No output-state ownership.
import {pickJointCandidates,projectJoints,cycleJointCandidate,beginPointerGesture,updatePointerGesture,endPointerGesture} from './joint-picking.js';
export function attachJointPicker({viewport,canvas,camera,rig,enabled=()=>true,isSheet=()=>false,onSelect,onHover=()=>{}}){
 const marker=document.createElement('div');marker.className='joint-hover';marker.hidden=true;marker.setAttribute('aria-hidden','true');viewport.append(marker);
 let gesture=null,hover=null,lastClick=null,disposed=false;
 const size=()=>({width:viewport.clientWidth,height:viewport.clientHeight});
 const sample=e=>{const r=canvas.getBoundingClientRect(),s=size();return {pointerId:e.pointerId,x:(e.clientX-r.left)*s.width/r.width,y:(e.clientY-r.top)*s.height/r.height,button:e.button,isPrimary:e.isPrimary};};
 const projection=()=>{camera.updateMatrixWorld(true);return {camera,...size(),joints:rig.jointRecords(),layers:rig.pickCategories()};};
 const candidates=p=>pickJointCandidates({...projection(),pointer:p,radius:24});
 function show(value){hover=value;marker.hidden=!value;if(value){marker.style.left=value.x+'px';marker.style.top=value.y+'px';marker.title=String(value.id);}onHover(value);}
 function down(e){if(!enabled()||isSheet()||rig.pointerBusy()){gesture=null;return;}if(gesture&&e.pointerId!==gesture.pointerId){gesture=null;return;}gesture=beginPointerGesture(sample(e));}
 function move(e){if(!enabled()||isSheet()||rig.pointerBusy()){gesture=null;show(null);return;}const samples=e.getCoalescedEvents?.();for(const ev of samples?.length?samples:[e])gesture=updatePointerGesture(gesture,sample(ev));show(gesture?.maxDistance>5?null:candidates(sample(e))[0]||null);}
 function up(e){if(!gesture||e.pointerId!==gesture.pointerId)return;const ended=endPointerGesture(gesture,sample(e));gesture=null;if(!ended.click||!enabled()||isSheet()||rig.pointerBusy())return;const items=candidates(ended.pointer),now=performance.now(),repeat=lastClick&&now-lastClick.time<2500&&Math.hypot(ended.pointer.x-lastClick.x,ended.pointer.y-lastClick.y)<8;
 const picked=cycleJointCandidate(items,lastClick?.id,{advance:!!(e.altKey||repeat)});if(picked){lastClick={...ended.pointer,id:picked.id,time:now};rig.select(picked.index);onSelect(picked);}else lastClick=null;show(picked);}
 function cancel(e){if(!gesture||e.pointerId===gesture.pointerId)gesture=null;show(null);}
 const handlers={pointerdown:down,pointermove:move,pointerup:up,pointercancel:cancel,pointerleave:()=>show(null)};
 for(const [name,fn]of Object.entries(handlers))canvas.addEventListener(name,fn,{capture:true});
 return {project(){if(disposed)return;if(!enabled()||isSheet()){show(null);return;}if(hover){const p=projectJoints(projection()).find(j=>j.id===hover.id);if(p){marker.style.left=p.x+'px';marker.style.top=p.y+'px';}else show(null);}},projection:()=>projectJoints(projection()),metadata:()=>({jointPicking:enabled()}),dispose(){disposed=true;for(const [name,fn]of Object.entries(handlers))canvas.removeEventListener(name,fn,{capture:true});marker.remove();}};
}
