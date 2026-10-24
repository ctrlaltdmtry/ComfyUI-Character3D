/**
 * Stateless, CPU-only adapter for actual vendored Three.js Bone chains.
 *
 * matchLimbToIK({upper, lower, end, preferredBend?, previousBend?, previousDirection?})
 *   -> {ok:true, root, elbow, end, target, pole, bendInfo, diagnostics, error:null}
 * solveLimbPose({upper, lower, end, target, pole, limits?, previousBend?,
 *                previousDirection?, preferredBend?})
 *   -> {ok:true, rotations:{upper:[x,y,z],lower:[x,y,z]}, root, elbow, end,
 *       bendInfo, diagnostics, error:null}
 *
 * target/pole are WORLD points; optional bend/direction hints are WORLD vectors.
 * All vectors are dense arrays of exactly three finite numbers. Returned local
 * rotations are XYZ Eulers in RADIANS, not deltas or biomechanical constraints.
 * limits is an optional record with upper and/or lower entries, each exactly
 * {min:[x,y,z], max:[x,y,z]} (finite radians, min[i] <= max[i]). Omitted limbs
 * are unbounded. Explicit undefined/null, scalars, sparse arrays and unknown
 * option/limit keys are errors. Limits are scalar Euler component bounds.
 *
 * Bones must form upper -> lower -> end DIRECT parent links. Upper/lower must
 * use XYZ order. All ancestors and the chain must use automatic local/world
 * matrices, finite position/unit quaternion and EXACT unit scale. Scaled actors
 * (including uniform scale), matrix-authored transforms, zero-length segments,
 * and non-XYZ upper/lower Euler orders are explicitly rejected, not approximated.
 * Current local positions define current segment lengths, including morph refits;
 * no bind/rest axes, local positions, endpoint local rotation or hierarchy change.
 *
 * A detached ancestor/chain copy supplies coherent world matrices; no caller
 * matrices, dirty flags, transforms, children, scene, camera or userData mutate.
 * Desired world rotations use minimal swing of the CURRENT segment followed by
 * its current world quaternion, retaining twist where possible. Upper is applied
 * before solving lower. Euler representations are chosen near current XYZ
 * values. Both desired local rotations are then component-clamped, and endpoint
 * diagnostics are recomputed from the clamped chain. No stretching or constrained
 * optimization is performed. End LOCAL rotation remains unchanged; its world
 * orientation naturally inherits moved ancestors (only a no-op preserves it).
 *
 * Match returns the actual FK end as target and a pole displaced by total limb
 * length in the observed bend direction. At near-straight poses (perpendicular
 * elbow offset <= 1e-8 of upper length), projected previous/preferred bend then
 * a transformed local Cartesian axis provide a stable nondegenerate pole. Exact
 * folds at root choose a direction perpendicular to the actual elbow, keeping
 * the folded FK pose representable. Match's bendInfo vectors can be passed back
 * as previousBend/previousDirection. It owns no persistent state.
 *
 * No-op solutions retain original XYZ values (including full turns) for the
 * exact FK endpoint with its matched bend pole. In the near-straight noise
 * band, any nondegenerate pole at the exact FK endpoint preserves the pose;
 * move the target to request bending. Otherwise analytic elbow/end differences
 * <= 1e-10 of total length plus world-coordinate rounding allowance also count
 * as no-op. Limits still apply to no-ops. diagnostics.targetError is
 * the ACTUAL post-clamp endpoint error; geometryTargetError is the analytic reach
 * error. reach/unreachable/reachClamped describe geometry only; angleClamped,
 * clampedAxes and endpointReached explicitly describe the resulting rotations.
 * bendInfo describes the analytic solve, not an invented post-limit bend plane.
 * All success data is detached plain JSON. Failure returns null result fields
 * and error:{code,field,message}; numerical solver failures are propagated.
 */
import * as THREE from './vendor/three.module.js';
import {solveTwoBoneIK} from './two-bone-ik.js';

const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const axes = ['x', 'y', 'z'];
const TAU = 2 * Math.PI;
class PoseError extends Error {
  constructor(code, field, message) { super(message); this.code = code; this.field = field; }
}
function reject(field, message, code = 'INVALID_INPUT') { throw new PoseError(code, field, message); }
function failure(error) {
  return {ok:false, rotations:null, root:null, elbow:null, end:null, target:null,
    pole:null, bendInfo:null, diagnostics:null,
    error:{code:error.code, field:error.field, message:error.message}};
}
function record(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function vector(v, field) {
  if (!Array.isArray(v) || v.length !== 3 || ![0,1,2].every(i => owns(v, i) && typeof v[i] === 'number' && Number.isFinite(v[i]))) {
    reject(field, 'Expected a dense array of exactly three finite numbers.');
  }
}
function inputRecord(input, allowed) {
  if (!record(input)) reject('input', 'Expected an options record.');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) reject(key, 'Unknown option.');
  for (const key of ['previousBend', 'preferredBend', 'previousDirection']) if (owns(input, key)) vector(input[key], key);
}
function validateLimits(limits) {
  if (!record(limits)) reject('limits', 'Expected a record with optional upper/lower min/max records.');
  for (const name of Object.keys(limits)) {
    if (!['upper', 'lower'].includes(name)) reject(`limits.${name}`, 'Unknown limb limit.');
    const entry = limits[name];
    if (!record(entry) || Object.keys(entry).some(k => !['min', 'max'].includes(k))) reject(`limits.${name}`, 'Expected exactly min and max triplets.');
    vector(entry.min, `limits.${name}.min`); vector(entry.max, `limits.${name}.max`);
    if (entry.min.some((v,i) => v > entry.max[i])) reject(`limits.${name}`, 'Each min must be <= max.');
  }
}
function asVector(a) { return new THREE.Vector3(...a); }
function unit(v) {
  const scale = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  if (scale === 0) return null;
  return v.clone().divideScalar(scale).normalize();
}
function perpendicular(v, direction) {
  const n = unit(v);
  if (!n) return null;
  const p = new THREE.Vector3().crossVectors(direction, new THREE.Vector3().crossVectors(n, direction));
  return p.length() > 1e-10 ? unit(p) : null;
}
function xyz(bone) { return axes.map(k => bone.rotation[k]); }
function position(bone) { return new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld); }
function worldQuaternion(bone) { return bone.getWorldQuaternion(new THREE.Quaternion()); }
function finiteResult(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) reject('geometry', 'Result exceeds finite numeric range.', 'NUMERIC_RANGE');
  if (value && typeof value === 'object') for (const [key,v] of Object.entries(value)) {
    finiteResult(v);
    // Keep the fresh JSON result bit-for-bit round-trippable (JSON has no -0).
    if (typeof v === 'number' && v === 0) value[key] = 0;
  }
  return value;
}
function attempt(fn) {
  try { return finiteResult(fn()); }
  catch (error) { if (error instanceof PoseError) return failure(error); throw error; }
}

function snapshot(input) {
  const {upper, lower, end} = input;
  for (const name of ['upper', 'lower', 'end']) if (!(input[name] instanceof THREE.Bone)) reject(name, 'Expected an actual vendored Three.js Bone.');
  if (upper === lower || lower === end || upper === end || lower.parent !== upper || end.parent !== lower) reject('chain', 'Expected distinct direct upper -> lower -> end links.');
  for (const name of ['upper', 'lower']) if (input[name].rotation.order !== 'XYZ') reject(`${name}.rotation.order`, 'Only local XYZ Euler rotations are supported.');
  const lineage = [], seen = new Set();
  for (let node = end; node; node = node.parent) {
    if (seen.has(node)) reject('chain', 'Cyclic parent hierarchy.');
    seen.add(node); lineage.unshift(node);
  }
  let parent = null;
  const copies = new Map();
  for (const original of lineage) {
    const field = original === upper ? 'upper' : original === lower ? 'lower' : original === end ? 'end' : 'ancestor';
    if (!original.matrixAutoUpdate || !original.matrixWorldAutoUpdate) reject(`${field}.matrixAutoUpdate`, 'Automatic local and world matrices are required.');
    if (axes.some(k => original.scale[k] !== 1)) reject(`${field}.scale`, 'Actor/chain scale is unsupported; every scale must be exactly [1,1,1].', 'UNSUPPORTED_SCALE');
    if (!axes.every(k => Number.isFinite(original.position[k]) && Number.isFinite(original.rotation[k])) ||
        !['x','y','z','w'].every(k => Number.isFinite(original.quaternion[k]))) reject(field, 'Transform components must be finite.');
    if (Math.abs(original.quaternion.lengthSq() - 1) > 1e-10) reject(`${field}.quaternion`, 'Expected a unit quaternion.');
    const copy = original.isBone ? new THREE.Bone() : new THREE.Object3D();
    copy.position.copy(original.position);
    copy.rotation.order = original.rotation.order;
    copy.quaternion.copy(original.quaternion);
    if (parent) parent.add(copy);
    parent = copy; copies.set(original, copy);
  }
  const top = copies.get(lineage[0]); top.updateMatrixWorld(true);
  for (const copy of copies.values()) if (!copy.matrixWorld.elements.every(Number.isFinite)) reject('geometry', 'World matrices exceed numeric range.', 'NUMERIC_RANGE');
  const u = copies.get(upper), l = copies.get(lower), e = copies.get(end);
  const root = position(u), elbow = position(l), tip = position(e);
  const length1 = root.distanceTo(elbow), length2 = elbow.distanceTo(tip);
  if (![length1,length2].every(n => Number.isFinite(n) && n > 0)) reject('chain', 'World segments must have finite nonzero lengths.');
  if (!Number.isFinite(length1 + length2)) reject('geometry', 'Total reach exceeds numeric range.', 'NUMERIC_RANGE');
  // Copy raw Euler components as well, retaining full turns at no-op matching.
  u.rotation.set(...xyz(upper), 'XYZ'); l.rotation.set(...xyz(lower), 'XYZ');
  top.updateMatrixWorld(true);
  return {upper:u, lower:l, end:e, top, root, elbow, tip, length1, length2};
}
function canonical(direction, quaternion) {
  const candidates = [new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)]
    .map(v => v.applyQuaternion(quaternion));
  candidates.sort((a,b) => Math.abs(a.dot(direction)) - Math.abs(b.dot(direction)));
  return perpendicular(candidates[0], direction);
}
function matched(snapshot, input) {
  const {root, elbow, tip, upper, length1, length2} = snapshot;
  const first = unit(elbow.clone().sub(root)), offset = tip.clone().sub(root);
  let direction = unit(offset), directionSource = 'endpoint';
  if (!direction) {
    direction = owns(input, 'previousDirection') ? perpendicular(asVector(input.previousDirection), first) : null;
    directionSource = direction ? 'previous' : 'local-axis';
    direction ??= canonical(first, worldQuaternion(upper));
  }
  const projected = new THREE.Vector3().crossVectors(direction, new THREE.Vector3().crossVectors(elbow.clone().sub(root), direction));
  let bend = projected.length() > 1e-8 * length1 ? unit(projected) : null;
  let bendSource = bend ? 'fk' : null;
  for (const [key, source] of [['previousBend','previous'], ['preferredBend','preferred']]) {
    if (!bend && owns(input, key)) { bend = perpendicular(asVector(input[key]), direction); if (bend) bendSource = source; }
  }
  if (!bend) { bend = canonical(direction, worldQuaternion(upper)); bendSource = 'local-axis'; }
  const pole = root.clone().addScaledVector(bend, length1 + length2);
  return {ok:true, root:root.toArray(), elbow:elbow.toArray(), end:tip.toArray(),
    target:tip.toArray(), pole:pole.toArray(),
    bendInfo:{direction:direction.toArray(), bendDirection:bend.toArray(), planeNormal:new THREE.Vector3().crossVectors(direction,bend).normalize().toArray()},
    diagnostics:{length1,length2,bendSource,directionSource,nearStraight:projected.length() <= 1e-8 * length1}, error:null};
}

export function matchLimbToIK(input) {
  return attempt(() => {
    inputRecord(input, ['upper','lower','end','preferredBend','previousBend','previousDirection']);
    return matched(snapshot(input), input);
  });
}
function nearestEuler(quaternion, reference) {
  const e = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  const wrap = (v,i) => v + TAU * Math.round((reference[i] - v) / TAU);
  const a = [e.x,e.y,e.z].map(wrap), b = [e.x + Math.PI, Math.PI - e.y, e.z + Math.PI].map(wrap);
  const cost = v => v.reduce((sum,x,i) => sum + (x-reference[i]) ** 2, 0);
  return cost(a) <= cost(b) ? a : b;
}
function align(bone, child, desiredDirection) {
  const current = unit(position(child).sub(position(bone))), desired = unit(desiredDirection);
  if (!desired) reject('geometry', 'Solved segment has zero direction.', 'PRECISION_LOSS');
  const swing = new THREE.Quaternion().setFromUnitVectors(current, desired);
  const world = swing.multiply(worldQuaternion(bone)).normalize();
  const parentInverse = bone.parent ? worldQuaternion(bone.parent).invert() : new THREE.Quaternion();
  return nearestEuler(parentInverse.multiply(world).normalize(), xyz(bone));
}

export function solveLimbPose(input) {
  return attempt(() => {
    inputRecord(input, ['upper','lower','end','target','pole','limits','previousBend','previousDirection','preferredBend']);
    vector(input.target, 'target'); vector(input.pole, 'pole');
    if (owns(input,'limits')) validateLimits(input.limits);
    const s = snapshot(input), fallback = matched(s, input);
    const geometry = {root:s.root.toArray(), target:input.target, pole:input.pole, length1:s.length1, length2:s.length2,
      previousBend:owns(input,'previousBend') ? input.previousBend : fallback.bendInfo.bendDirection,
      previousDirection:owns(input,'previousDirection') ? input.previousDirection : fallback.bendInfo.direction};
    if (owns(input,'preferredBend')) geometry.preferredBend = input.preferredBend;
    const solved = solveTwoBoneIK(geometry);
    if (!solved.ok) throw new PoseError(solved.error.code, solved.error.field, solved.error.message);
    const tolerance = 1e-10 * (s.length1 + s.length2) + 32 * Number.EPSILON * Math.max(...s.root.toArray().map(Math.abs), ...s.tip.toArray().map(Math.abs));
    // Match deliberately suppresses tiny near-straight elbow noise in its pole.
    // At the exact FK endpoint, an equivalent match pole must therefore retain
    // the current pose rather than rotate that noise into the fallback plane.
    const poleBend = perpendicular(asVector(input.pole).sub(s.root), asVector(fallback.bendInfo.direction));
    const exactFKMatch = input.target.every((v,i) => v === s.tip.toArray()[i]) && poleBend !== null &&
      (fallback.diagnostics.nearStraight || poleBend.distanceTo(asVector(fallback.bendInfo.bendDirection)) <= 1e-10);
    const noOp = exactFKMatch || (s.elbow.distanceTo(asVector(solved.elbow)) <= tolerance && s.tip.distanceTo(asVector(solved.end)) <= tolerance);
    const desired = {upper:xyz(s.upper), lower:xyz(s.lower)};
    if (!noOp) {
      desired.upper = align(s.upper, s.lower, asVector(solved.elbow).sub(s.root));
      s.upper.rotation.set(...desired.upper, 'XYZ'); s.top.updateMatrixWorld(true);
      desired.lower = align(s.lower, s.end, asVector(solved.end).sub(asVector(solved.elbow)));
    }
    const rotations = {}, clampedAxes = {upper:[],lower:[]};
    for (const name of ['upper','lower']) {
      const bounds = input.limits?.[name];
      rotations[name] = desired[name].map((value,i) => {
        const result = bounds ? Math.max(bounds.min[i], Math.min(bounds.max[i], value)) : value;
        if (result !== value) clampedAxes[name].push(axes[i]);
        return result === 0 ? 0 : result;
      });
      s[name].rotation.set(...rotations[name], 'XYZ');
    }
    s.top.updateMatrixWorld(true);
    const elbow = position(s.lower), end = position(s.end), targetError = end.distanceTo(asVector(input.target));
    const angleClamped = clampedAxes.upper.length + clampedAxes.lower.length > 0;
    return {ok:true, rotations, root:s.root.toArray(), elbow:elbow.toArray(), end:end.toArray(), bendInfo:solved.bendInfo,
      diagnostics:{...solved.diagnostics, length1:s.length1, length2:s.length2,
        geometryTargetError:solved.diagnostics.targetError, reachClamped:solved.diagnostics.clamped,
        targetError, endpointError:targetError, analyticEndpointError:end.distanceTo(asVector(solved.end)),
        angleClamped, clampedAxes, clamped:solved.diagnostics.clamped || angleClamped,
        endpointReached:targetError <= tolerance, noOp:noOp && !angleClamped}, error:null};
  });
}
