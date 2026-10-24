import * as THREE from 'three';
import {projectedSurface} from './eye-surface.js';
const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
const xyz=(array,index)=>new THREE.Vector3().fromArray(array,index*3);
export function sampleContour(points,x){
 const sorted=[...points].sort((a,b)=>a.x-b.x);if(x<=sorted[0].x)return sorted[0].clone();if(x>=sorted.at(-1).x)return sorted.at(-1).clone();
 for(let i=1;i<sorted.length;i++)if(x<=sorted[i].x){const a=sorted[i-1],b=sorted[i],t=(x-a.x)/(b.x-a.x||1);return a.clone().lerp(b,t);}
 return sorted.at(-1).clone();
}
export function sealContours(upper,lower,strength=1,clearance=.0004){
 // Both sides sample the same current contact line; unequal authored sampling is preserved.
 const u=upper.map(p=>p.clone()),l=lower.map(p=>p.clone());
 for(let iteration=0;iteration<4;iteration++){
  const oldU=u.map(p=>p.clone()),oldL=l.map(p=>p.clone());
  for(const [own,other,sign] of [[u,oldL,1],[l,oldU,-1]])for(let i=0;i<own.length;i++){
   const p=own===u?oldU[i]:oldL[i],q=sampleContour(other,p.x);
   // Exact shared corner vertices stay untouched; do not pull the mouth wider or collapse corners.
   if(i===0||i===own.length-1)continue;
   own[i].y+=(.5*(p.y+q.y)+sign*clearance*.5-p.y)*strength;
   own[i].z+=(.5*(p.z+q.z)-p.z)*strength;
  }
 }
 return [u,l];
}
export function attachFaceContact({body,eyes,rig,definition}){
 if(definition.bodyVertices!==body.geometry.attributes.position.count)throw Error('Face-contact topology mismatch');
 const headIndex=rig.bones.findIndex(b=>b.name==='head');
 const neighbors=Array.from({length:body.geometry.attributes.position.count},()=>new Set()),indices=body.geometry.index.array;
 for(let i=0;i<indices.length;i+=3)for(const [a,b]of [[indices[i],indices[i+1]],[indices[i+1],indices[i+2]],[indices[i+2],indices[i]]]){neighbors[a].add(b);neighbors[b].add(a);}
 const temporary=new THREE.Vector3(),boneMatrix=new THREE.Matrix4(),blend=new THREE.Matrix4(),inverse=new THREE.Matrix4();
 const lidTriangles=new Map(definition.eyes.map(lid=>{const allowed=new Set(lid.region.map(([id])=>id)),out=[];for(let j=0;j<indices.length;j+=3){const ids=[indices[j],indices[j+1],indices[j+2]];if(ids.some(id=>allowed.has(id)))out.push(ids);}return [lid.name,out];}));
 let sourceSnapshot=[];
 let latest={mouthVertices:0,eyeVertices:0,correctedVertices:0,maxDelta:0,mouthGap:0};
 function apply(state){
  const skeleton=body.skeleton,head=skeleton.bones[headIndex];
  const before=body.geometry.attributes.position.array,baseline=Array.from(before),cache=new Map(),original=new Map(),deltas=new Map();
  sourceSnapshot=baseline;
  const restHead=new THREE.Vector3().setFromMatrixPosition(skeleton.boneInverses[headIndex].clone().invert()),headInverse=head.matrixWorld.clone().invert(),bodyInverse=body.matrixWorld.clone().invert();
  const read=i=>{if(!cache.has(i)){body.getVertexPosition(i,temporary);const p=temporary.clone().applyMatrix4(body.matrixWorld).applyMatrix4(headInverse).add(restHead);cache.set(i,p);original.set(i,p.clone());}return cache.get(i);};
  function commit(region,seeds){
   const allowed=new Set(region.map(([id])=>id)),weights=new Map([...seeds].map(([id,d])=>[id,{delta:d.clone(),weight:1}]));let frontier=new Set(seeds.keys());
   for(let depth=1;depth<=2;depth++){
    const next=new Set(),collected=new Map();for(const id of frontier)for(const n of neighbors[id])if(allowed.has(n)&&!weights.has(n)){const item=collected.get(n)||{delta:new THREE.Vector3(),weight:0};item.delta.add(weights.get(id).delta);item.weight++;collected.set(n,item);next.add(n);}
    for(const [id,item]of collected){item.delta.multiplyScalar(1/item.weight);weights.set(id,item);}frontier=next;
   }
   for(const [id,depth]of region){const item=weights.get(id);if(!item)continue;const d=item.delta.clone().multiplyScalar([1,.55,.15][depth]||0);if(d.lengthSq()<1e-18)continue;deltas.set(id,(deltas.get(id)||new THREE.Vector3()).add(d));}
  }
  let mouthVertices=0;
  // Manual lip-bone edits intentionally override the automatic neutral contact solve.
  const manualMouth=Object.entries(state.faceOffsets||{}).some(([n,v])=>n.startsWith('oris')&&v.some(x=>Math.abs(x)>1e-7))||Object.entries(state.pose||{}).some(([n,v])=>n.startsWith('oris')&&v.some(x=>Math.abs(x)>1e-7));
  const jaw=state.pose?.jaw||[0,0,0],mouthStrength=manualMouth?0:1-smooth(.025,.12,Math.max(...jaw.map(Math.abs)));
  if(mouthStrength>0){
   const m=definition.mouth,u=m.upper.map(read),l=m.lower.map(read),[su,sl]=sealContours(u,l,mouthStrength),seeds=new Map();
   for(const [ids,old,now]of [[m.upper,u,su],[m.lower,l,sl]])for(let i=0;i<ids.length;i++){const d=now[i].clone().sub(old[i]);if(d.length()>.06)d.setLength(.06);seeds.set(ids[i],d);}
   // The corresponding inner lip row follows the rim correction without changing lip thickness.
   for(let i=0;i<m.outer.length;i++){const d=seeds.get(m.outer[i]);if(d)seeds.set(m.inner[i],d.clone());}
   commit(m.region,seeds);mouthVertices=seeds.size;
  }
  // Conform to the actual fitted/rotated eye, in the posed head's anatomical frame.
  const ep=new Float32Array(eyes.geometry.attributes.position.count*3);
  for(let i=0;i<ep.length/3;i++){eyes.getVertexPosition(i,temporary);temporary.applyMatrix4(eyes.matrixWorld).applyMatrix4(headInverse).add(restHead).toArray(ep,i*3);}
  const surface=projectedSurface(ep,eyes.geometry.index.array);
  let eyeVertices=0;
  for(const lid of definition.eyes){
   const side=lid.name==='eye.L'?'l':'r',close=Math.max(0,Math.min(1,state.expressions?.['eye_close_'+side]||0)),strength=smooth(.75,1,close);
   const manual=Object.entries(state.faceOffsets||{}).some(([n,v])=>/^orbicularis/.test(n)&&n.endsWith(lid.name.slice(-2))&&v.some(x=>Math.abs(x)>1e-7));
   if(manual)continue;
   // Preserve authored blink XY and folds. Only move skin forward when it intersects the eye.
   const seeds=new Map();
   for(const [ids,clearance]of [[lid.outer,.003],[lid.inner,.0005]])for(const id of ids){const p=read(id),z=surface(p.x,p.y);seeds.set(id,new THREE.Vector3(0,0,z===undefined?0:Math.min(.025,Math.max(0,z+clearance-p.z))));}
   commit(lid.region,seeds);eyeVertices+=seeds.size;
   if(strength>0){
    // Vertex contact alone misses curved-eye / planar-skin intersections inside triangles.
    const allowed=new Set(lid.region.map(([id])=>id)),triangles=lidTriangles.get(lid.name);
    const samples=[[1/3,1/3,1/3],[.5,.5,0],[.5,0,.5],[0,.5,.5],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]];
    const current=id=>read(id).clone().add(deltas.get(id)||new THREE.Vector3());
    for(let pass=0;pass<3;pass++)for(const ids of triangles){
     const points=ids.map(current),normal=new THREE.Vector3().subVectors(points[1],points[0]).cross(new THREE.Vector3().subVectors(points[2],points[0])).normalize();if(normal.z<.1)continue;
     for(const weights of samples){const p=new THREE.Vector3();ids.forEach((id,k)=>p.addScaledVector(current(id),weights[k]));const z=surface(p.x,p.y);if(z===undefined)continue;const deficit=(z+.002-p.z)*strength;if(deficit<=0||deficit>.03)continue;
      const denominator=ids.reduce((n,id,k)=>n+(allowed.has(id)?weights[k]**2:0),0);if(denominator<.05)continue;
      ids.forEach((id,k)=>{if(!allowed.has(id))return;const d=deltas.get(id)||new THREE.Vector3();d.z=Math.min(.025,d.z+deficit*weights[k]/denominator);deltas.set(id,d);});
     }
    }
   }
  }
  for(const [id,delta]of deltas){
   const wanted=read(id).clone().add(delta).sub(restHead).applyMatrix4(head.matrixWorld).applyMatrix4(bodyInverse);
   // Invert the actual blended skin transform; contact stays correct under head/body poses.
   blend.elements.fill(0);const si=body.geometry.attributes.skinIndex,sw=body.geometry.attributes.skinWeight;
   for(let j=0;j<4;j++){const b=si.array[id*4+j],w=sw.array[id*4+j];if(!w)continue;boneMatrix.fromArray(skeleton.boneMatrices,b*16);for(let k=0;k<16;k++)blend.elements[k]+=boneMatrix.elements[k]*w;}
   inverse.copy(body.bindMatrixInverse).multiply(blend).multiply(body.bindMatrix);
   if(Math.abs(inverse.determinant())<1e-8)continue;wanted.applyMatrix4(inverse.invert());before[id*3]=wanted.x;before[id*3+1]=wanted.y;before[id*3+2]=wanted.z;
  }
  let maxDelta=0;for(const id of deltas.keys())maxDelta=Math.max(maxDelta,xyz(before,id).distanceTo(xyz(baseline,id)));
  body.geometry.attributes.position.needsUpdate=true;body.geometry.computeVertexNormals();body.geometry.computeBoundingBox();body.geometry.computeBoundingSphere();
  const mouth=definition.mouth,readAfter=i=>{body.getVertexPosition(i,temporary);return temporary.clone().applyMatrix4(body.matrixWorld).applyMatrix4(headInverse).add(restHead);},up=mouth.upper.map(readAfter),low=mouth.lower.map(readAfter);
  const gap=Math.max(...[...up,...low].map(p=>sampleContour(up,p.x).y-sampleContour(low,p.x).y));
  latest={mouthVertices,eyeVertices,correctedVertices:deltas.size,maxDelta,mouthGap:gap,mouthStrength};return latest;
 }
 return {apply,metrics:()=>({...latest}),definition,sourceGeometry:()=>sourceSnapshot.slice(),sourcePosedGeometry:()=>{const out=[],v=new THREE.Vector3();for(let i=0;i<sourceSnapshot.length/3;i++){v.fromArray(sourceSnapshot,i*3);body.applyBoneTransform(i,v);out.push(v.x,v.y,v.z);}return out;}};
}
