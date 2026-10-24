import * as THREE from 'three';
import {validateSheetCamera} from './web/sheet-state.js';
import {layoutSheet} from './sheet-layout.js';

// Camera constructors own no actor, OrbitControls or saved view; each returns a fresh camera.
export function createSheetCamera(cell,aspect,{bodyBounds,faceBounds=bodyBounds}){
 if(!Number.isFinite(aspect)||aspect<=0)throw Error('Некорректные пропорции ячейки.');
 if(cell.preset==='custom'){
  const c=validateSheetCamera(cell.camera),h=c.height;
  const cam=new THREE.OrthographicCamera(-h*aspect/2,h*aspect/2,h/2,-h/2,c.near,c.far);
  cam.position.fromArray(c.position);cam.up.fromArray(c.up);cam.zoom=c.zoom;
  const raw=c.position.map((v,i)=>v-c.target[i]),scale=Math.max(...raw.map(Math.abs)),upScale=Math.max(...c.up.map(Math.abs));
  const direction=new THREE.Vector3().fromArray(raw.map(v=>v/scale)).normalize(),up=new THREE.Vector3().fromArray(c.up.map(v=>v/upScale)).normalize();
  cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(direction,new THREE.Vector3(),up));cam.updateProjectionMatrix();cam.updateMatrixWorld(true);return cam;
 }
 const directions={front:[0,0,1],left:[1,0,0],back:[0,0,-1],right:[-1,0,0],'three-quarter':[1,0,1],face:[0,0,1],'face-left':[1,0,0]};
 if(!Object.hasOwn(directions,cell.preset))throw Error('Неизвестный ракурс ячейки.');
 const box=cell.preset.startsWith('face')?faceBounds:bodyBounds;
 if(!box?.isBox3||box.isEmpty())throw Error('Нет границ персонажа.');
 const target=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
 if(![...target.toArray(),...size.toArray()].every(Number.isFinite)||size.length()<=0)throw Error('Некорректные границы персонажа.');
 const direction=new THREE.Vector3().fromArray(directions[cell.preset]).normalize(),right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),direction).normalize();
 let horizontal=0;for(const x of [box.min.x,box.max.x])for(const z of [box.min.z,box.max.z])horizontal=Math.max(horizontal,Math.abs(new THREE.Vector3(x-target.x,0,z-target.z).dot(right)));
 const h=Math.max(size.y,horizontal*2/aspect,.001)*(cell.preset.startsWith('face')?1.18:1.12),distance=Math.max(bodyBounds.getSize(new THREE.Vector3()).length(),h,1)*3;
 const cam=new THREE.OrthographicCamera(-h*aspect/2,h*aspect/2,h/2,-h/2,.001,distance*3);
 cam.position.copy(target).addScaledVector(direction,distance);cam.up.set(0,1,0);cam.lookAt(target);cam.updateProjectionMatrix();cam.updateMatrixWorld(true);return cam;
}
export function cameraDescriptor(cam,target){return {position:cam.position.toArray(),target:target.toArray(),zoom:cam.zoom,height:cam.top-cam.bottom,near:cam.near,far:cam.far,up:cam.up.toArray()};}
export function sheetCameraDescriptor(cell,aspect,bounds){
 const cam=createSheetCamera(cell,aspect,bounds),target=cell.preset==='custom'?new THREE.Vector3().fromArray(cell.camera.target):(cell.preset.startsWith('face')?bounds.faceBounds:bounds.bodyBounds).getCenter(new THREE.Vector3());
 return validateSheetCamera(cameraDescriptor(cam,target));
}
// Read the real skinned body, retaining its neutral face region while posing.
export function measureSheetBounds(body,neutralBounds){
 if(!body?.geometry?.attributes?.position||!neutralBounds?.isBox3||neutralBounds.isEmpty())throw Error('Модель не готова.');
 body.updateWorldMatrix(true,false);const full=new THREE.Box3(),face=new THREE.Box3(),v=new THREE.Vector3(),p=body.geometry.attributes.position;
 const faceThreshold=neutralBounds.max.y-(neutralBounds.max.y-neutralBounds.min.y)*.17;
 for(let i=0;i<p.count;i++){body.getVertexPosition(i,v);v.applyMatrix4(body.matrixWorld);full.expandByPoint(v);if(p.getY(i)>=faceThreshold)face.expandByPoint(v);}
 if(face.isEmpty())face.copy(full);return {bodyBounds:full,faceBounds:face};
}
export function renderSheet({renderer,scene,sheet,outputWidth,outputHeight,width,height,frame={x:0,y:0,width,height},bounds}){
 const cells=layoutSheet(sheet,outputWidth,outputHeight),viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),test=renderer.getScissorTest(),auto=renderer.autoClear;
 try{
  renderer.autoClear=false;renderer.setScissorTest(true);
  for(const r of cells){const i=r.image,x=frame.x+i.x*frame.width/outputWidth,y=height-frame.y-(i.y+i.height)*frame.height/outputHeight,w=i.width*frame.width/outputWidth,h=i.height*frame.height/outputHeight;
   renderer.setViewport(x,y,w,h);renderer.setScissor(x,y,w,h);renderer.render(scene,createSheetCamera(sheet.cells[r.index],i.width/i.height,bounds));
  }
 }finally{renderer.autoClear=auto;renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(test);}
 return cells;
}
// Captions are explicit output content: when enabled their alpha participates in foreground MASK.
export function composeSheetPNG(source,sheet,width,height,canvasFactory=()=>document.createElement('canvas')){
 const cells=layoutSheet(sheet,width,height),canvas=canvasFactory();canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas2D недоступен для подписей листа.');
 ctx.drawImage(source,0,0);ctx.fillStyle=sheet.labelColor;ctx.font=`500 ${sheet.labelSize}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
 for(const r of cells)if(r.label&&sheet.cells[r.index].label){const t=r.label;ctx.save();ctx.beginPath();ctx.rect(t.x,t.y,t.width,t.height);ctx.clip();const full=sheet.cells[r.index].label;let text=full;if(ctx.measureText(text).width>t.width-8){const chars=Array.from(text);while(chars.length&&ctx.measureText(chars.join('')+'…').width>t.width-8)chars.pop();text=chars.join('')+'…';}ctx.fillText(text,t.x+t.width/2,t.y+t.height/2);ctx.restore();}
 return canvas;
}
