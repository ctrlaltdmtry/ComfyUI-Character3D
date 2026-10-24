// Original sparse/paired identity blending; no dependency on an authoring runtime.
const checked = new WeakMap();
export function validateDelta(delta, length) {
 if (!delta || typeof delta !== 'object') throw Error('Missing morph delta');
 if (checked.get(delta) === length) return delta;
 if (Array.isArray(delta)) {
  if (delta.length !== length || !delta.every(Number.isFinite)) throw Error('Invalid dense morph delta');
 } else {
  const {indices, values} = delta;
  if (!Array.isArray(indices) || !Array.isArray(values) || values.length !== indices.length * 3 || !values.every(Number.isFinite)) throw Error('Invalid sparse morph delta');
  let previous = -1;
  for (const i of indices) { if (!Number.isInteger(i) || i <= previous || i < 0 || i * 3 + 2 >= length) throw Error('Invalid sparse morph index'); previous = i; }
 }
 checked.set(delta, length); return delta;
}
function addDelta(out, delta, scale) {
 if (!scale) return;
 if (Array.isArray(delta)) { for (let i=0;i<out.length;i++) out[i] += delta[i]*scale; }
 else { const {indices,values}=delta; for(let i=0;i<indices.length;i++){const k=indices[i]*3,j=i*3;out[k]+=values[j]*scale;out[k+1]+=values[j+1]*scale;out[k+2]+=values[j+2]*scale;} }
}
export function blendMorph(out, morph, weight, sex) {
 if (!Number.isFinite(weight) || !Number.isFinite(sex)) throw Error('Non-finite morph weight');
 if (!weight) return;
 const negative=weight<0 && morph.negativeDelta;
 const female=negative?morph.negativeDelta:morph.delta;
 const male=(negative?morph.negativeMaleDelta:morph.maleDelta)||female;
 const factor=negative?-weight:weight;
 validateDelta(female,out.length);validateDelta(male,out.length);
 // Keep legacy dense arithmetic bit-for-bit: old saved faces must not drift.
 if(Array.isArray(female)&&Array.isArray(male)){for(let i=0;i<out.length;i++)out[i]+=(female[i]+(male[i]-female[i])*sex)*factor;return;}
 if(female===male){addDelta(out,female,factor);return;}
 addDelta(out,female,factor*(1-sex));addDelta(out,male,factor*sex);
}
export function morphRange(morph, free=false) {
 const legacy=!morph.id.startsWith('identity_');
 const min=Number.isFinite(morph.min)?morph.min:0,max=Number.isFinite(morph.max)?morph.max:1;
 if(!free)return [min,max];
 return [legacy?Math.min(-1,min):min<0?-1.5:0,1.5];
}
export function clampMorph(morph,value,free=false){const [min,max]=morphRange(morph,free);return Number.isFinite(value)?Math.max(min,Math.min(max,value)):0;}
export function connectIdentity(identity,body,rig,parts=[]) {
 if(identity?.schema!=='character-3d-identity/1'||!Array.isArray(identity.morphs))throw Error('Unknown identity asset schema');
 const existing=new Set(body.morphs.map(m=>m.id));
 const sources=[['body',body],['eyes',body.eyes],...parts.map(p=>[p.source.id,p.source])];
 // Preflight the whole asset before changing any runtime source.
 for(const m of identity.morphs){
  if(typeof m.id!=='string'||!/^identity_[a-z0-9_]+$/.test(m.id)||existing.has(m.id))throw Error('Duplicate or invalid identity ID');existing.add(m.id);
  if(!Number.isFinite(m.min)||!Number.isFinite(m.max)||m.min>0||m.max<0||m.min>=m.max)throw Error('Invalid identity range');
  if(m.min<0&&!m.negativeDelta)throw Error('Missing authored negative endpoint');
  for(const [name,source] of sources){const channels=name==='body'?m:name==='eyes'?m.eyes:m.parts?.[name];if(!source||!channels)throw Error('Missing identity attachment '+name+' / '+m.id);for(const key of ['delta','maleDelta','negativeDelta','negativeMaleDelta'])if(channels[key])validateDelta(channels[key],source.positions.length);if(!channels.delta)throw Error('Missing positive endpoint '+name);if(m.min<0&&!channels.negativeDelta)throw Error('Missing negative attachment endpoint '+name);}
  if(!m.rig?.delta)throw Error('Missing identity rig pivots');for(const key of ['delta','maleDelta','negativeDelta','negativeMaleDelta'])if(m.rig[key])validateDelta(m.rig[key],rig.bones.length*3);if(m.min<0&&!m.rig.negativeDelta)throw Error('Missing negative rig pivots');
 }
 for(const m of identity.morphs){body.morphs.push(m);body.eyes.morphs.push({id:m.id,...m.eyes});rig.morphs.push({id:m.id,...m.rig});for(const p of parts)p.source.morphs.push({id:m.id,...m.parts[p.source.id]});}
 return identity.morphs.length;
}
