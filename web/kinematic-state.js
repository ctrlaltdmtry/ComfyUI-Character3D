// Optional render-affecting IK contract. Absence is preserved by callers for legacy hashes.
export const kinematicSchema='character-3d-kinematics/1';
export const limbIds=Object.freeze(['arm.L','arm.R','leg.L','leg.R']);
const object=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.prototype.toString.call(v)!=='[object Object]'||Reflect.ownKeys(v).some(k=>typeof k!=='string'||!keys.includes(k)))throw Error('Некорректный объект FK/IK.');};
const vector=(v,bound)=>{if(!Array.isArray(v)||v.length!==3||![0,1,2].every(i=>Object.hasOwn(v,i)&&typeof v[i]==='number'&&Number.isFinite(v[i])&&Math.abs(v[i])<=bound))throw Error('Некорректный вектор FK/IK.');const out=[];for(let i=0;i<3;i++)out.push(v[i]===0?0:v[i]);return out;};
export function validateKinematics(input){
 object(input,['schema','limbs']);if(!Object.hasOwn(input,'schema')||input.schema!==kinematicSchema||!Object.hasOwn(input,'limbs'))throw Error('Неизвестная схема FK/IK.');object(input.limbs,limbIds);const limbs={};
 for(const id of Object.keys(input.limbs)){const c=input.limbs[id];object(c,['target','pole','bend','direction']);if(!Object.hasOwn(c,'target')||!Object.hasOwn(c,'pole'))throw Error('Не заданы цель и полюс FK/IK.');const o={target:vector(c.target,1000),pole:vector(c.pole,1000)};for(const k of ['bend','direction'])if(Object.hasOwn(c,k))o[k]=vector(c[k],1);limbs[id]=o;}
 return {schema:kinematicSchema,limbs};
}
