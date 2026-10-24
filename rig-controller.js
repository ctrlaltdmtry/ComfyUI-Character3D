import * as THREE from 'three';
import {TransformControls} from './vendor/TransformControls.js';
import {blendMorph} from './identity-morphs.js';
import {rigLayerDefaults,normalizeRigLayers,boneCategory,enabledCategories,layerVisibility} from './rig-layers.js';
import {matchLimbToIK,solveLimbPose} from './kinematic-pose.js';
import {validateKinematics,kinematicSchema,limbIds} from './web/kinematic-state.js';
const D=180/Math.PI;
// TransformControls mutates the shared canvas style on connect/disconnect.
// Keep that interaction policy until the last rig releases its listeners.
const canvasControls=new WeakMap();
export function attachRig(body,eyes,source,rig,scene,camera,canvas,orbit,onChange,parts=[],options={}){
 // A separate display scene opts into actor-local skinning. Legacy callers
 // retain detached mode and their existing world-space bind calculation.
 const displayScene=options.displayScene||scene,actorLocal=!!options.displayScene;
 const bones=rig.bones.map(b=>{const o=new THREE.Bone();o.name=b.name;return o;});
 const roots=new THREE.Group();roots.name='CharacterArmature';
 rig.bones.forEach((b,i)=>{if(b.parent>=0)bones[b.parent].add(bones[i]);else roots.add(bones[i]);});scene.add(roots);
 const skeleton=new THREE.Skeleton(bones),bindHeads=[],restLocals=[];
 const facialNames=new Set(rig.faceBones||rig.bones.slice(53).map(b=>b.name));
 function skinned(mesh,index,weight){if(!mesh)return null;mesh.geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(index,4));mesh.geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weight,4));const m=new THREE.SkinnedMesh(mesh.geometry,mesh.material);m.bindMode=actorLocal?'attached':'detached';m.frustumCulled=false;mesh.removeFromParent();scene.add(m);return m;}
 const skinnedBody=skinned(body,rig.skinIndex,rig.skinWeight);
 const headIndex=Math.max(0,rig.bones.findIndex(b=>/^head(?:$|[._])/i.test(b.name)));
 const eyeCount=eyes?.geometry.attributes.position.count||0;
 const eyeIndex=rig.eyeSkinIndex||Array.from({length:eyeCount*4},(_,i)=>i%4?0:headIndex),eyeWeight=rig.eyeSkinWeight||Array.from({length:eyeCount*4},(_,i)=>i%4?0:1);
 const skinnedEyes=skinned(eyes,eyeIndex,eyeWeight);
 const skinnedParts=parts.map(p=>skinned(p.mesh,p.source.skinIndex,p.source.skinWeight));
 const helper=new THREE.Group();helper.name='RigDisplayLayers';displayScene.add(helper);
 const categories=bones.map(b=>boneCategory(b.name,facialNames)),lineGeometry=new THREE.BufferGeometry(),jointGeometry=new THREE.BufferGeometry();
 lineGeometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(bones.length*6),3));jointGeometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(bones.length*3),3));
 const lines=new THREE.LineSegments(lineGeometry,new THREE.LineBasicMaterial({color:'#99b8d7',transparent:true,opacity:.72,depthWrite:false}));
 const dots=new THREE.Points(jointGeometry,new THREE.PointsMaterial({color:'#c3d9d0',size:7,sizeAttenuation:false,transparent:true,opacity:.92,depthWrite:false}));
 dots.material.onBeforeCompile=s=>{s.fragmentShader=s.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif(length(gl_PointCoord-vec2(0.5))>0.5)discard;');};
 lines.frustumCulled=dots.frustumCulled=false;lines.renderOrder=dots.renderOrder=20;helper.add(lines,dots);
 const canvasOwner=canvasControls.get(canvas)||{count:0,touchAction:canvas.style.touchAction??'auto'};
 const transform=new TransformControls(camera,canvas);canvasOwner.count++;canvasControls.set(canvas,canvasOwner);transform.setMode('rotate');transform.setSpace('local');transform.setSize(.65);const gizmo=transform.getHelper();gizmo.visible=false;displayScene.add(gizmo);
 let currentState,selected=headIndex,mutating=false,refreshing=false,active=true,disposed=false,orbitBlocked=false,layers=rigLayerDefaults(),exportHidden=false;
 let activeLimb=limbIds[0],ikHandle=null,goalDragging=false,ikDiagnostics={};
 const limbNames={'arm.L':['upperarm_l','lowerarm_l','hand_l'],'arm.R':['upperarm_r','lowerarm_r','hand_r'],'leg.L':['thigh_l','calf_l','foot_l'],'leg.R':['thigh_r','calf_r','foot_r']};
 const limbIndices=Object.fromEntries(limbIds.map(id=>[id,limbNames[id].map(n=>bones.findIndex(b=>b.name===n))]));
 const goalRoot=new THREE.Group();goalRoot.name='IKGoals';roots.add(goalRoot);
 const proxies=Object.fromEntries(limbIds.map(id=>[id,Object.fromEntries(['target','pole'].map(kind=>{const p=new THREE.Object3D();p.name=id+':'+kind;goalRoot.add(p);return [kind,p];}))]));
 const goal=id=>currentState?.kinematics?.limbs[id];
 function chain(id){if(!limbIds.includes(id)||limbIndices[id].some(i=>i<0))throw Error('Цепь FK/IK отсутствует: '+id);const [u,l,e]=limbIndices[id];return {upper:bones[u],lower:bones[l],end:bones[e]};}
 function toWorld(a){return roots.localToWorld(new THREE.Vector3(...a)).toArray();}
 function fromWorld(a){return roots.worldToLocal(new THREE.Vector3(...a)).toArray();}
 function hintWorld(a){return new THREE.Vector3(...a).applyQuaternion(roots.getWorldQuaternion(new THREE.Quaternion())).normalize().toArray();}
 function hintLocal(a){return new THREE.Vector3(...a).applyQuaternion(roots.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize().toArray();}
 function syncGoals(){for(const id of limbIds)for(const k of ['target','pole'])if(goal(id))proxies[id][k].position.fromArray(goal(id)[k]);}
 function solveKinematics(){
  ikDiagnostics={};if(!currentState.kinematics){syncGoals();return;}currentState.kinematics=validateKinematics(currentState.kinematics);roots.updateMatrixWorld(true);
  for(const id of limbIds){const c=goal(id);if(!c)continue;const [u,l]=limbIndices[id],limits={};for(const [name,i]of [['upper',u],['lower',l]])limits[name]={min:[0,1,2].map(a=>-limit(i,a)/D),max:[0,1,2].map(a=>limit(i,a)/D)};
   const options={...chain(id),target:toWorld(c.target),pole:toWorld(c.pole),limits};if(c.bend)options.previousBend=hintWorld(c.bend);if(c.direction)options.previousDirection=hintWorld(c.direction);
   const r=solveLimbPose(options);ikDiagnostics[id]=r.ok?{ok:true,...r.diagnostics}:r; if(r.ok){bones[u].rotation.set(...r.rotations.upper);bones[l].rotation.set(...r.rotations.lower);c.bend=hintLocal(r.bendInfo.bendDirection);c.direction=hintLocal(r.bendInfo.direction);roots.updateMatrixWorld(true);}
  }syncGoals();
 }
 // Render pose is derived from serialized FK reference + IK goals. Never feed
 // angle-clamped output back into its own reference on bind/Freeze/reload.
 function referencePose(){const p=cleanPose();for(const id of limbIds)if(goal(id))for(const i of limbIndices[id].slice(0,2)){const n=bones[i].name,a=currentState.pose?.[n];if(a)p[n]=a.slice();else delete p[n];}return p;}
 function promoteFK(id){if(!goal(id))return;for(const i of limbIndices[id].slice(0,2)){const b=bones[i],a=[b.rotation.x,b.rotation.y,b.rotation.z];if(a.some(v=>Math.abs(v)>1e-7))currentState.pose[b.name]=a;else delete currentState.pose[b.name];}delete currentState.kinematics.limbs[id];if(!Object.keys(currentState.kinematics.limbs).length)delete currentState.kinematics;if(activeLimb===id)ikHandle=null;}
 function promoteSelected(){for(const id of limbIds)if(limbIndices[id].slice(0,2).includes(selected))promoteFK(id);}
 function selectLimb(id){if(!interactive())return;chain(id);activeLimb=id;selected=limbIndices[id][0];ikHandle=null;transform.setMode('rotate');transform.setSpace('local');refreshHelpers();}
 function selectIKHandle(id,kind){if(!interactive())return;chain(id);if(!goal(id)||!['target','pole'].includes(kind))return;activeLimb=id;ikHandle=kind;transform.setMode('translate');transform.setSpace('world');syncGoals();refreshHelpers();}
 function setLimbMode(id,mode){if(!interactive())return;chain(id);if(!['fk','ik'].includes(mode))throw Error('Неизвестный режим FK/IK.');activeLimb=id;if(mode==='fk'){promoteFK(id);ikHandle=null;transform.setMode('rotate');transform.setSpace('local');syncPose();return;}if(!goal(id)){const r=matchLimbToIK(chain(id));if(!r.ok)throw Error(r.error.message);const k=currentState.kinematics||{schema:kinematicSchema,limbs:{}};k.limbs[id]={target:fromWorld(r.target),pole:fromWorld(r.pole),bend:hintLocal(r.bendInfo.bendDirection),direction:hintLocal(r.bendInfo.direction)};currentState.kinematics=validateKinematics(k);}selectIKHandle(id,'target');syncPose();}
 function setLimbGoal(id,kind,value){if(!interactive()||!goal(id)||!['target','pole'].includes(kind))return;const k=validateKinematics(currentState.kinematics);k.limbs[id][kind]=value;currentState.kinematics=validateKinematics(k);syncPose();}
 const isSheet=()=>options.isSheetView?options.isSheetView():currentState?.view==='sheet';
 const interactive=()=>active&&!disposed&&!exportHidden&&!isSheet();
 function notify(value){if(interactive()&&!mutating&&!refreshing)onChange(value);}
 function updateArmature(){scene.updateWorldMatrix(true,false);roots.updateMatrixWorld(true);}
 function cancelInteraction(){
  goalDragging=false;transform.enabled=false;transform.dragging=false;transform.axis=null;transform.detach();
  if(orbitBlocked){orbit.enabled=!isSheet();orbitBlocked=false;}
 }
 function setActive(value){if(disposed)return;active=!!value;refreshHelpers();}
 function refreshHelpers(){
  if(disposed)return;
  refreshing=true;
  helper.visible=interactive();transform.enabled=interactive();const target=ikHandle&&goal(activeLimb)?proxies[activeLimb][ikHandle]:bones[selected],category=ikHandle&&goal(activeLimb)?'body':categories[selected],canControl=interactive()&&layerVisibility(layers,category,{exporting:exportHidden,sheet:isSheet()}).controllers;
  if(!interactive())cancelInteraction();
  if(canControl&&transform.object!==target)transform.attach(target);else if(!canControl&&transform.object)transform.detach();gizmo.visible=canControl;
  for(const object of [lines,dots])object.material.depthTest=!layers.xray;
  gizmo.traverse(o=>{for(const m of Array.isArray(o.material)?o.material:[o.material])if(m)m.depthTest=!layers.xray;});
  refreshing=false;
 }
 function viewChanged(){refreshHelpers();if(active&&!disposed&&!transform.dragging&&!goalDragging)orbit.enabled=!isSheet();}
 function projectHelpers(){
  if(disposed)return;updateArmature();let lineCount=0,jointCount=0;const v=new THREE.Vector3(),p=new THREE.Vector3(),lp=lineGeometry.attributes.position,jp=jointGeometry.attributes.position;
  bones.forEach((b,i)=>{const visible=layerVisibility(layers,categories[i],{exporting:exportHidden,sheet:isSheet()});b.getWorldPosition(v);if(visible.joints)jp.setXYZ(jointCount++,v.x,v.y,v.z);const parent=rig.bones[i].parent;if(visible.bones&&parent>=0){bones[parent].getWorldPosition(p);lp.setXYZ(lineCount++,p.x,p.y,p.z);lp.setXYZ(lineCount++,v.x,v.y,v.z);}});
  lp.needsUpdate=jp.needsUpdate=true;lineGeometry.setDrawRange(0,lineCount);jointGeometry.setDrawRange(0,jointCount);lines.visible=lineCount>0;dots.visible=jointCount>0;
 }
 function cleanPose(){const p={};bones.forEach(b=>{const a=[b.rotation.x,b.rotation.y,b.rotation.z];if(a.some(v=>Math.abs(v)>1e-7))p[b.name]=a;});return p;}
 function limit(i,axis){const name=bones[i].name.toLowerCase();if(currentState?.free)return 180;if(facialNames.has(bones[i].name)){if(/^eye[._]/.test(name))return axis===1?25:18;if(name==='jaw')return axis===0?20:3.5;return 15;}if(/finger|thumb|toe/.test(name))return axis===0?100:45;if(/head|neck|spine/.test(name))return 55;return 150;}
 function syncPose(){currentState.pose=referencePose();currentState.faceOffsets={};bones.forEach((b,i)=>{if(!facialNames.has(b.name))return;const d=b.position.clone().sub(restLocals[i]);if(d.lengthSq()>1e-12)currentState.faceOffsets[b.name]=d.toArray();});apply(currentState);updateArmature();skeleton.update();notify(currentState.pose);}
 transform.addEventListener('dragging-changed',e=>{if(!interactive()||refreshing)return;orbitBlocked=!!e.value;orbit.enabled=!e.value&&!isSheet();});
 transform.addEventListener('objectChange',()=>{if(mutating||refreshing||!interactive())return;if(ikHandle&&goal(activeLimb)){const v=transform.object.position.clone().clampScalar(-1000,1000).toArray();setLimbGoal(activeLimb,ikHandle,v);return;}promoteSelected();const bone=bones[selected];if(transform.mode==='translate'){const d=bone.position.clone().sub(restLocals[selected]),limit=currentState.free?.25:.08;d.clampScalar(-limit,limit);bone.position.copy(restLocals[selected]).add(d);}['x','y','z'].forEach((ax,i)=>bone.rotation[ax]=THREE.MathUtils.clamp(bone.rotation[ax],-limit(selected,i)/D,limit(selected,i)/D));syncPose();});
 transform.addEventListener('change',()=>notify(null));
 function bind(state){if(disposed)return;currentState=state;mutating=true;
  const positions=rig.bones.map(b=>b.head.map((v,j)=>v+((b.maleHead||b.head)[j]-v)*state.sex));
  const pivots=new Float64Array(positions.flat());
  for(const m of rig.morphs||[]){const w=(m.expression?state.expressions?.[m.id]:state.morphs[m.id])||0;blendMorph(pivots,m,w,state.sex);}
  positions.forEach((p,i)=>p.forEach((v,j)=>p[j]=pivots[i*3+j]));
  rig.bones.forEach((b,i)=>{bindHeads[i]=new THREE.Vector3(...positions[i]);bones[i].rotation.set(0,0,0);bones[i].position.copy(bindHeads[i]);if(b.parent>=0)bones[i].position.sub(new THREE.Vector3(...positions[b.parent]));restLocals[i]=bones[i].position.clone();});
  updateArmature();
  // Accumulate the actual rest hierarchy in actor space, never matrixWorld.
  // This preserves legacy floating-point geometry at identity placement and
  // keeps repeated morph refits independent of the actor's world placement.
  if(actorLocal){
   const restMatrices=new Map();
   const restMatrix=bone=>{if(!restMatrices.has(bone))restMatrices.set(bone,(bone.parent?.isBone?restMatrix(bone.parent):new THREE.Matrix4()).clone().multiply(bone.matrix));return restMatrices.get(bone);};
   skeleton.boneInverses=bones.map(bone=>restMatrix(bone).clone().invert());
  }else skeleton.calculateInverses();
  skinnedBody.bind(skeleton,new THREE.Matrix4());skinnedEyes?.bind(skeleton,new THREE.Matrix4());skinnedParts.forEach(p=>p.bind(skeleton,new THREE.Matrix4()));apply(state);mutating=false;
 }
 function apply(state){if(disposed)return;currentState=state;mutating=true;for(let i=0;i<bones.length;i++){bones[i].position.copy(restLocals[i]);if(facialNames.has(bones[i].name)){const d=state.faceOffsets?.[bones[i].name];if(Array.isArray(d)&&d.length===3&&d.every(Number.isFinite))bones[i].position.add(new THREE.Vector3(...d).clampScalar(state.free?-.25:-.08,state.free?.25:.08));}const p=state.pose?.[bones[i].name]||[0,0,0];bones[i].rotation.set(...p.map((v,j)=>THREE.MathUtils.clamp(Number(v)||0,-limit(i,j)/D,limit(i,j)/D)));}updateArmature();state.pose=cleanPose();solveKinematics();if(ikHandle&&!goal(activeLimb)){ikHandle=null;transform.setMode('rotate');transform.setSpace('local');}updateArmature();skeleton.update();for(const mesh of [skinnedBody,skinnedEyes,...skinnedParts])mesh?.updateMatrixWorld(true);refreshHelpers();mutating=false;}
 function select(index){if(!interactive())return bones[selected].name;ikHandle=null;transform.setSpace('local');selected=Math.max(0,Math.min(bones.length-1,index));if(!facialNames.has(bones[selected].name)&&transform.mode==='translate')transform.setMode('rotate');refreshHelpers();return bones[selected].name;}
 function setLayers(value){if(disposed)return;layers=normalizeRigLayers(value);refreshHelpers();notify(null);}
 function visible(value){setLayers({...layers,bones:!!value});}
 function rotation(axis,degrees){if(!interactive())return;ikHandle=null;promoteSelected();bones[selected].rotation[axis]=THREE.MathUtils.clamp(degrees,-limit(selected,['x','y','z'].indexOf(axis)),limit(selected,['x','y','z'].indexOf(axis)))/D;syncPose();}
 function preset(name){
  if(!interactive())return;
  const pose={};const set=(pattern,rot)=>{const i=rig.bones.findIndex(b=>pattern.test(b.name));if(i>=0)pose[bones[i].name]=rot.map(v=>v/D);};
  if(name==='relaxed'){
   set(/^(upperarm|upper_arm|arm)[_.]?[lL]$/, [0,0,-20]);set(/^(upperarm|upper_arm|arm)[_.]?[rR]$/, [0,0,20]);
  }else if(name==='portrait'){set(/^neck(?:$|[._])/, [0,0,-5]);set(/^head(?:$|[._])/, [0,12,0]);}
  else if(name==='contrapposto'){set(/^spine(?:$|[._])/, [0,0,4]);set(/^head(?:$|[._])/, [0,-10,-4]);}
  delete currentState.kinematics;ikHandle=null;ikDiagnostics={};currentState.pose=pose;apply(currentState);syncPose();
 }
 function dispose(){
  if(disposed)return;disposed=true;active=false;cancelInteraction();helper.visible=gizmo.visible=false;
  // Rig owns the skeleton and scene objects, not caller-owned mesh buffers,
  // materials or textures (the actor factory releases those separately).
  transform.dispose();canvasOwner.count--;canvas.style.touchAction=canvasOwner.count?'none':canvasOwner.touchAction;if(!canvasOwner.count)canvasControls.delete(canvas);
  skeleton.dispose();lineGeometry.dispose();jointGeometry.dispose();lines.material.dispose();dots.material.dispose();
  for(const object of [helper,gizmo,roots,skinnedBody,skinnedEyes,...skinnedParts])object?.removeFromParent();roots.clear();
 }
 return {body:skinnedBody,eyes:skinnedEyes,parts:skinnedParts,bones,bind,apply,select,visible,rotation,preset,viewChanged,projectHelpers,setActive,setLayers,getLayers:()=>({...layers}),pickCategories:()=>interactive()?enabledCategories(layers):[],pointerBusy:()=>interactive()&&(goalDragging||!!transform.dragging||transform.axis!==null),
  selectLimb,selectIKHandle,setLimbMode,setLimbGoal,setGoalDrag:value=>{if(interactive())goalDragging=!!value;},goalFromWorld:p=>fromWorld(p.toArray()),
  kinematicValues:()=>({id:activeLimb,mode:goal(activeLimb)?'ik':'fk',handle:ikHandle,goals:goal(activeLimb)?JSON.parse(JSON.stringify(goal(activeLimb))):null,diagnostics:ikDiagnostics[activeLimb]?JSON.parse(JSON.stringify(ikDiagnostics[activeLimb])):null}),
  ikGoalRecords:()=>interactive()?limbIds.filter(id=>goal(id)).flatMap(id=>['target','pole'].map(kind=>({id:id+':'+kind,category:'body',position:toWorld(goal(id)[kind])}))):[],
  jointRecords:()=>interactive()?bones.map((b,i)=>({id:b.name,category:categories[i],position:b.getWorldPosition(new THREE.Vector3()).toArray()})):[],
  editorState:()=>({rigLayers:{...layers},selectedJoint:bones[selected].name,activeLimb,ikHandle}),
  setEditor:value=>{if(disposed)return;const next=value?.rigLayers?normalizeRigLayers(value.rigLayers):rigLayerDefaults(),wasMutating=mutating;mutating=true;try{layers=next;if(typeof value?.selectedJoint==='string'){const i=bones.findIndex(b=>b.name===value.selectedJoint);if(i>=0)selected=i;}activeLimb=limbIds.includes(value?.activeLimb)?value.activeLimb:limbIds[0];ikHandle=goal(activeLimb)&&['target','pole'].includes(value?.ikHandle)?value.ikHandle:null;if(ikHandle){transform.setMode('translate');transform.setSpace('world');}else{transform.setMode('rotate');transform.setSpace('local');}refreshHelpers();}finally{mutating=wasMutating;}},
  setMode:mode=>{if(!interactive())return;ikHandle=null;transform.setSpace('local');transform.setMode(mode==='translate'&&facialNames.has(bones[selected].name)?'translate':'rotate');notify(null);},
  values:()=>({name:bones[selected].name,rotation:[bones[selected].rotation.x,bones[selected].rotation.y,bones[selected].rotation.z].map(v=>v*D),limits:[0,1,2].map(i=>limit(selected,i)),facial:facialNames.has(bones[selected].name)}),
  snapshotHelpers:()=>({exportHidden}),hideHelpers:()=>{exportHidden=true;refreshHelpers();},restoreHelpers:v=>{exportHidden=v.exportHidden;refreshHelpers();},
  dispose,
  posedBounds:()=>{skinnedBody.computeBoundingBox();return skinnedBody.boundingBox.clone();},
  faceTarget:rest=>{const p=rest.clone().sub(bindHeads[headIndex]);return bones[headIndex].localToWorld(p);},
  metrics:()=>({bones:bones.length,skinVertices:skinnedBody.geometry.attributes.skinWeight.count,poseBones:Object.keys(cleanPose()).length,facialBones:facialNames.size,controllerAxis:transform.axis,controllerDragging:!!transform.dragging,kinematics:{activeLimb,ikHandle,goalDragging,limbs:JSON.parse(JSON.stringify(ikDiagnostics))},display:{lines:helper.visible&&lines.visible?lineGeometry.drawRange.count/2:0,joints:helper.visible&&dots.visible?jointGeometry.drawRange.count:0,controller:gizmo.visible,xray:layers.xray,depthTest:lines.material.depthTest}}),
 };
}
