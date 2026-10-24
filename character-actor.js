import * as THREE from 'three';
import {attachRig} from './rig-controller.js';
import {attachFaceContact} from './face-contact.js';
import {blendMorph} from './identity-morphs.js';
import {measureSheetBounds} from './sheet-renderer.js';

// Sources and the eye texture are borrowed, read-only assets. All mutable Three
// objects, vertex/skin buffers, materials, state and contact caches are per actor.
function makeMesh(source,material){
 const positions=source?.positions,indices=source?.indices;
 if(!positions||!indices||!positions.length||positions.length%3||indices.length%3||
    !Array.from(positions).every(Number.isFinite)||
    !Array.from(indices).every(i=>Number.isInteger(i)&&i>=0&&i<positions.length/3))throw Error('Invalid character geometry');
 if(source.male&&(source.male.length!==positions.length||!Array.from(source.male).every(Number.isFinite)))throw Error('Character endpoint topology mismatch');
 if(source.uv&&(source.uv.length!==positions.length/3*2||!Array.from(source.uv).every(Number.isFinite)))throw Error('Invalid character UVs');
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(positions),3));
 // Explicit copies also cover callers supplying typed arrays instead of JSON.
 geometry.setIndex(new THREE.BufferAttribute(new (positions.length/3>65535?Uint32Array:Uint16Array)(indices),1));
 if(source.uv)geometry.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(source.uv),2));
 geometry.computeVertexNormals();geometry.computeBoundingSphere();
 return new THREE.Mesh(geometry,material);
}
function mixPositions(mesh,source,state){
 const attribute=mesh.geometry.attributes.position,out=attribute.array,base=source.positions,male=source.male||base;
 for(let i=0;i<out.length;i++)out[i]=base[i]+(male[i]-base[i])*state.sex;
 for(const morph of source.morphs||[]){const weight=state.expressions?.[morph.id]??state.morphs?.[morph.id]??0;if(weight)blendMorph(out,morph,weight,state.sex);}
 attribute.needsUpdate=true;mesh.geometry.computeVertexNormals();mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();
}
function copyState(value){
 const state=structuredClone(value||{});
 state.sex=Math.max(0,Math.min(1,Number(state.sex)||0));
 state.morphs??={};state.expressions??={};state.pose??={};state.faceOffsets??={};
 return state;
}
function vector(value,label){
 const result=value?.isVector3?value.toArray():value;
 if(!Array.isArray(result)||result.length!==3||!result.every(Number.isFinite))throw Error('Invalid actor '+label);
 return result;
}

/**
 * Independent, synchronous runtime. Assets must already be loaded/combined by
 * the caller (including identity/expression morphs). No fetch, renderer or UI.
 * update(next) takes a full state replacement, not a patch; actor.state remains
 * stable so editor bindings can retain it. Change callbacks never call update.
 * Placement uses actor-local radians (Euler XYZ) and actor-local IK goals.
 * The caller owns the shared eyeTexture and must dispose it after all actors.
 */
export function createCharacterActor({id,state:initialState,data,rigData,partsData=[],contactDefinition=null,eyeTexture=null,scene,camera,canvas,orbit,onChange=()=>{},isSheetView=()=>false}){
 if(!scene?.isObject3D||!camera?.isCamera||!canvas?.addEventListener||!orbit)throw Error('Character actor requires scene, camera, canvas and orbit');
 if(!rigData?.bones?.length)throw Error('Character actor requires a rig');
 if(contactDefinition&&!data?.eyes)throw Error('Face contact requires eyes');
 const state=copyState(initialState),root=new THREE.Group();root.name='CharacterActor:'+String(id);
 const material=new THREE.MeshStandardMaterial({color:'#c9b9a7',roughness:.79,metalness:0});
 const meshes=[],materials=new Set([material]);let body,eyes=null,parts=[],rig=null,contact=null,disposed=false,active=true,visible=true,updates=0,updateMs=0;
 function live(){if(disposed)throw Error('Character actor is disposed');}
 function update(next){
  live();if(next&&next!==state){const copied=copyState(next);for(const key of Object.keys(state))delete state[key];Object.assign(state,copied);}
  const start=performance.now();
  mixPositions(body,data,state);if(eyes)mixPositions(eyes,data.eyes,state);for(const p of parts)mixPositions(p.mesh,p.source,state);
  root.updateWorldMatrix(true,true);root.updateMatrixWorld(true);rig.bind(state);root.updateWorldMatrix(true,true);root.updateMatrixWorld(true);contact?.apply(state);
  material.color.set(state.material==='skin'?state.skin:'#c9b9a7');material.wireframe=state.material==='wire';material.roughness=state.material==='skin'?.63:.79;
  rig.projectHelpers();updates++;updateMs=performance.now()-start;return actor;
 }
 function setPlacement(value={}){
  live();const position=value.position===undefined?null:vector(value.position,'position');
  const rotation=value.rotation===undefined?null:vector(value.rotation,'rotation');
  if(position)root.position.fromArray(position);if(rotation)root.rotation.set(...rotation);
  root.updateWorldMatrix(true,true);root.updateMatrixWorld(true);rig.apply(state);root.updateWorldMatrix(true,true);root.updateMatrixWorld(true);rig.projectHelpers();return actor;
 }
 function syncActive(){rig.setActive(active&&visible);}
 function dispose(){
  if(disposed)return;disposed=true;rig?.dispose();root.removeFromParent();
  // Set ownership avoids disposing shared body materials or buffers twice.
  for(const geometry of new Set(meshes.map(mesh=>mesh.geometry)))geometry.dispose();
  for(const mat of materials)mat.dispose();root.clear();
 }
 const actor={id,state,root,get body(){return body;},get eyes(){return eyes;},get parts(){return parts;},material,get rig(){return rig;},get contact(){return contact;},update,setPlacement,
  setVisible(value){live();visible=!!value;root.visible=visible;syncActive();return actor;},
  setActive(value){live();active=!!value;syncActive();return actor;},
  snapshotHelpers(){live();return rig.snapshotHelpers();},hideHelpers(){live();rig.hideHelpers();},restoreHelpers(snapshot){live();rig.restoreHelpers(snapshot);},
  bounds(){live();root.updateWorldMatrix(true,true);root.updateMatrixWorld(true);return measureSheetBounds(body,body.geometry.boundingBox);},dispose,
  metrics(){return {id,disposed,active:active&&visible&&!disposed,visible:visible&&!disposed,updates,updateMs,vertices:body?.geometry.attributes.position.count||0,triangles:(body?.geometry.index.count||0)/3,eyesVertices:eyes?.geometry.attributes.position.count||0,parts:parts.length,rig:disposed?null:rig?.metrics(),contact:disposed?null:contact?.metrics()};}
 };
 try{
  body=makeMesh(data,material);meshes.push(body);root.add(body);
  if(data.eyes){const mat=new THREE.MeshStandardMaterial({color:'#ffffff',map:eyeTexture,roughness:.4,alphaTest:.03});materials.add(mat);eyes=makeMesh(data.eyes,mat);meshes.push(eyes);root.add(eyes);}
  parts=partsData.map(source=>{const mat=new THREE.MeshStandardMaterial({color:source.material?.color||(/tongue/i.test(source.id)?'#986766':'#ded5bd'),roughness:source.material?.roughness||.6});materials.add(mat);const mesh=makeMesh(source,mat);meshes.push(mesh);root.add(mesh);return {mesh,source};});
  scene.add(root);
  rig=attachRig(body,eyes,data,rigData,root,camera,canvas,orbit,pose=>{if(!disposed&&active&&visible)onChange(pose);},parts,{displayScene:scene,isSheetView});
  body=rig.body;eyes=rig.eyes;parts.forEach((p,i)=>p.mesh=rig.parts[i]);
  if(contactDefinition)contact=attachFaceContact({body,eyes,rig:rigData,definition:contactDefinition});
  update();return actor;
 }catch(error){dispose();throw error;}
}
