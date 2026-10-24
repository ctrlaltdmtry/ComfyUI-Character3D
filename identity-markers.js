import * as THREE from 'three';
import {clampMorph} from './identity-morphs.js';
import {t,bindText,bindAttr} from './i18n.js';
const regions=[
 ['head','Голова','identity_head_width','identity_head_height','face'],
 ['eyes','Глаза','identity_eye_spacing','identity_eye_size','face'],
 ['nose','Нос','identity_nose_tip_width','identity_nose_length','face'],
 ['mouth','Губы','mouth_width','identity_upper_lip_volume','face'],
 ['jaw','Подбородок','chin_width','identity_chin_height','face'],
 ['ears','Уши','identity_ear_projection','identity_ear_size','face'],
 ['torso','Плечи','identity_shoulder_width','identity_torso_length','body'],
 ['torso','Талия','identity_waist','identity_torso_depth','body'],
 ['chest','Грудь','identity_breast_spacing','identity_breast_projection','body'],
 ['arms','Руки','identity_upper_arm_girth','identity_upper_arm_length','body'],
 ['legs','Бёдра','identity_hip_width','identity_thigh_length','body'],
 ['legs','Голени','identity_calf_girth','identity_calf_length','body'],
];
function anchor(morph,positions){
 const delta=morph.delta;let index=-1,best=-Infinity;
 const choose=(i,x,y,z)=>{const d=x*x+y*y+z*z;if(!d)return;const score=d*(positions[i*3]>=0?1:0.85);if(score>best){best=score;index=i;}};
 if(Array.isArray(delta)){for(let i=0;i<delta.length/3;i++)choose(i,...delta.slice(i*3,i*3+3));}
 else delta.indices.forEach((i,n)=>choose(i,...delta.values.slice(n*3,n*3+3)));
 return index;
}
export function attachIdentityMarkers({viewport,camera,body,data,state,orbit,change,invalidate,ui,isSheetView=()=>state.view==='sheet'}){
 const row=document.createElement('label');row.className='row';row.innerHTML='<span></span> <input id="shape-markers" type="checkbox">';document.querySelector('#morphs').before(row);
 const bindings=[bindText(row.querySelector('span'),'Маркеры формы')];
 const overlay=document.createElement('div');overlay.className='face-overlay identity-overlay';overlay.hidden=true;viewport.append(overlay);
 const entries=[];let shown=false,drag=null,disposed=false;
 for(const [group,title,xId,yId,view]of regions){const x=data.morphs.find(m=>m.id===xId),y=data.morphs.find(m=>m.id===yId);if(!x||!y)continue;const index=anchor(x,data.positions);if(index<0)continue;
  const button=document.createElement('button');button.type='button';button.className='face-marker shape-marker';button.dataset.shapeMarker=xId;button.textContent='✥';bindings.push(bindAttr(button,'aria-label','{label} · изменить форму',()=>({label:t(title)})),bindAttr(button,'title','{label} · горизонтально: {horizontal}; вертикально: {vertical}',()=>({label:t(title),horizontal:t(x.labelRu||x.label||x.id),vertical:t(y.labelRu||y.label||y.id)})));overlay.append(button);const entry={button,index,x,y,view};entries.push(entry);
  button.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();button.setPointerCapture(e.pointerId);ui.focusGroup(group);drag={entry,id:e.pointerId,x:e.clientX,y:e.clientY,vx:state.morphs[xId]||0,vy:state.morphs[yId]||0};button.classList.add('dragging');orbit.enabled=false;};
  button.onpointermove=e=>{if(drag?.entry!==entry)return;e.preventDefault();e.stopPropagation();state.morphs[xId]=clampMorph(x,drag.vx+(e.clientX-drag.x)/viewport.clientWidth*6,state.free);state.morphs[yId]=clampMorph(y,drag.vy-(e.clientY-drag.y)/viewport.clientHeight*6,state.free);change();ui.sync();};
  const release=()=>{if(drag?.entry!==entry)return;drag=null;button.classList.remove('dragging');orbit.enabled=!isSheetView();invalidate();};button.onpointerup=release;button.onpointercancel=release;button.onlostpointercapture=release;
 }
 row.querySelector('input').onchange=e=>{shown=e.target.checked;overlay.hidden=!shown;invalidate();};
 function project(){if(disposed)return;overlay.hidden=!shown||isSheetView();if(overlay.hidden)return;const p=new THREE.Vector3();for(const e of entries){if((state.view==='body')!==(e.view==='body')){e.button.hidden=true;continue;}body.getVertexPosition(e.index,p);body.localToWorld(p);p.project(camera);e.button.style.left=(p.x*.5+.5)*viewport.clientWidth+'px';e.button.style.top=(-p.y*.5+.5)*viewport.clientHeight+'px';e.button.hidden=p.z<-1||p.z>1||Math.abs(p.x)>1||Math.abs(p.y)>1;}}
 return {project,count:entries.length,dispose(){if(disposed)return;disposed=true;bindings.forEach(off=>off());row.querySelector('input').onchange=null;for(const {button}of entries)for(const key of ['onpointerdown','onpointermove','onpointerup','onpointercancel','onlostpointercapture'])button[key]=null;if(drag)orbit.enabled=!isSheetView();drag=null;row.remove();overlay.remove();}};
}
