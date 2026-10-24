import {Vector3, WebGLCoordinateSystem} from './vendor/three.module.js';

const CATEGORIES = ['body', 'hands', 'face'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const CLIP_EPSILON = 1e-12;
const PIXEL_EPSILON = 1e-9;
function nonnegative(value, name) {
  if (!finite(value) || value < 0) throw new TypeError(`${name} must be finite and nonnegative`);
  return value;
}
function dimension(value, name) {
  if (!finite(value) || value <= 0) throw new TypeError(`${name} must be finite and positive`);
}
function validPoint(value) { return !!value && finite(value.x) && finite(value.y); }
function validateCamera(camera) {
  if (!camera?.isOrthographicCamera || camera.coordinateSystem !== WebGLCoordinateSystem || camera.reversedDepth === true) throw new TypeError('A WebGL OrthographicCamera with standard depth is required');
  if (!finite(camera.near) || camera.near < 0 || !finite(camera.far) || camera.far <= camera.near || !finite(camera.zoom) || camera.zoom <= 0) throw new TypeError('Invalid camera near/far/zoom');
  if (![camera.left, camera.right, camera.top, camera.bottom].every(finite) || camera.left >= camera.right || camera.bottom >= camera.top) throw new TypeError('Invalid camera frustum');
  for (const name of ['matrixWorldInverse', 'projectionMatrix']) {
    const elements = camera[name]?.elements;
    if (!elements || elements.length !== 16 || !Array.from(elements).every(finite)) throw new TypeError(`Invalid camera.${name}`);
  }
}
function layerSet(layers) {
  if (!Array.isArray(layers) || !Array.from(layers).every(layer => CATEGORIES.includes(layer))) throw new TypeError('layers must be an array of body/hands/face categories');
  return new Set(layers);
}
function validJoint(joint) {
  if (!joint || !(typeof joint.id === 'string' && joint.id.length > 0 || finite(joint.id)) || !CATEGORIES.includes(joint.category)) return false;
  const p = joint.position;
  return Array.isArray(p) && p.length === 3 && [0, 1, 2].every(i => own(p, i) && finite(p[i]));
}
const inClip = value => finite(value) && value >= -1 - CLIP_EPSILON && value <= 1 + CLIP_EPSILON;
const clampClip = value => Math.max(-1, Math.min(1, value));

/**
 * Pure CPU projection; no DOM, renderer, model, listeners or camera mutations.
 * projectJoints({camera, width, height, joints, layers=['body','hands','face']})
 * -> [{id, category, index, x, y, depth}] in original joint-list order.
 *
 * camera is the caller's EXISTING vendored Three WebGL OrthographicCamera.
 * Caller must updateProjectionMatrix()/updateMatrixWorld(true) after edits,
 * before invoking this function. width/height are full viewport CSS dimensions,
 * NOT output-frame dimensions or device-pixel dimensions. x/y use top-left
 * viewport-local CSS pixels; depth is Three NDC z in [-1,1]. index is the source
 * list index (holes/skipped entries never renumber). IDs must be unique nonempty
 * strings or finite numbers if overlap cycling is used; numeric ID 0 is valid.
 *
 * Joints: {id, position:[worldX,worldY,worldZ], category:'body'|'hands'|'face'}.
 * Malformed/sparse/nonfinite, behind-camera and clipped/off-screen joints are
 * ignored. Frustum boundaries are inclusive (1e-12 NDC rounding tolerance).
 * layers alone controls eligibility: helper/skeleton/joint visibility is not
 * consulted, and layers:[] disables all hits. Configuration errors throw.
 */
export function projectJoints({camera, width, height, joints, layers = CATEGORIES} = {}) {
  validateCamera(camera); dimension(width, 'width'); dimension(height, 'height');
  if (!Array.isArray(joints)) throw new TypeError('joints must be an array');
  const enabled = layerSet(layers), result = [], point = new Vector3();
  for (let index = 0; index < joints.length; index++) {
    const joint = joints[index];
    if (!validJoint(joint) || !enabled.has(joint.category)) continue;
    point.fromArray(joint.position).applyMatrix4(camera.matrixWorldInverse);
    // Orthographic projection alone can include behind-camera points when near
    // is zero; explicitly require a point in the camera's forward half-space.
    if (![point.x, point.y, point.z].every(finite) || point.z >= 0) continue;
    point.applyMatrix4(camera.projectionMatrix);
    if (![point.x, point.y, point.z].every(inClip)) continue;
    result.push({id: joint.id, category: joint.category, index,
      x: (clampClip(point.x) + 1) * (width / 2),
      y: (1 - clampClip(point.y)) * (height / 2), depth: clampClip(point.z)});
  }
  return result;
}

/**
 * pickJointCandidates({...projectJoints arguments, pointer:{x,y}, radius=24})
 * -> projected records plus distance (CSS pixels), within a finite radius only.
 * Sorted nearest-first by screen distance, ties by source index, NOT depth.
 * Empty area/outside-viewport pointer -> []; radius 0 permits exact overlap.
 * Radius edges tolerate 1e-9 CSS pixels of projection round-off only.
 * Convert clientX/Y by subtracting canvas.getBoundingClientRect().left/top;
 * if CSS transforms scale the element, also rescale into width/height units.
 */
export function pickJointCandidates({pointer, radius = 24, ...projection} = {}) {
  nonnegative(radius, 'radius');
  if (!validPoint(pointer)) throw new TypeError('pointer must contain finite CSS x/y');
  const candidates = projectJoints(projection);
  if (pointer.x < 0 || pointer.y < 0 || pointer.x > projection.width || pointer.y > projection.height) return [];
  return candidates.map(candidate => ({...candidate, distance: Math.hypot(candidate.x - pointer.x, candidate.y - pointer.y)}))
    .filter(candidate => finite(candidate.distance) && candidate.distance <= radius + (radius === 0 ? 0 : PIXEL_EPSILON))
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
}

/**
 * cycleJointCandidate(candidates, previousId, {advance=false}) -> record | null.
 * Normally choose the nearest record; advance selects the successor of the
 * previous ID, wrapping. Missing previous ID starts at nearest; no candidates
 * returns null (never falls back to a stale selection). Pure/no list mutation.
 * Caller decides whether a click is repeated or Alt-click and retains the last
 * ID/location/time; reset that history when the pointer/eligible set changes.
 */
export function cycleJointCandidate(candidates, previousId, {advance = false} = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  if (!candidates.length) return null;
  const previous = advance ? candidates.findIndex(candidate => candidate.id === previousId) : -1;
  return candidates[(previous + 1) % candidates.length];
}

/**
 * Immutable click-vs-drag helpers, accepting viewport-local pointer samples:
 * {pointerId, x, y, button?, isPrimary?}. No events/listeners/capture are owned.
 * beginPointerGesture(sample, {threshold=5}) -> state | null (primary left only).
 * updatePointerGesture(state, sample) -> NEW state for matching-pointer motion.
 * endPointerGesture(state, sample, {cancelled=false})
 *   -> {click:boolean, maxDistance:number, pointer:{x,y}|null}.
 *
 * Store the state returned by every update. Feed ALL move/coalesced samples:
 * maxDistance is the maximum CSS displacement from pointerdown, not the final
 * displacement, so dragging away and returning cannot select. Exactly threshold
 * still counts as a click; final pointerup is sampled too. Invalid motion latches
 * cancellation. On pointercancel/lostpointercapture use cancelled:true (x/y may
 * be absent), discard state after a matching up/cancel. Unrelated pointer IDs
 * neither update state nor select; caller must not discard state on those ups.
 * End is pure, so the caller is responsible for discarding completed state and
 * not processing the same pointerup twice. For a multi-touch orbit, caller should
 * cancel the active gesture when a second pointer arrives. Damping/orbit motion
 * with no pointer movement is not inferred; caller may force cancelled:true.
 */
export function beginPointerGesture(sample, {threshold = 5} = {}) {
  nonnegative(threshold, 'threshold');
  if (!sample || !Number.isInteger(sample.pointerId) || sample.pointerId < 0 || !validPoint(sample)) throw new TypeError('A pointerId and finite CSS x/y are required');
  if ((sample.button ?? 0) !== 0 || sample.isPrimary === false) return null;
  return {pointerId: sample.pointerId, startX: sample.x, startY: sample.y, threshold, maxDistance: 0, cancelled: false};
}
export function updatePointerGesture(state, sample) {
  if (!state || sample?.pointerId !== state.pointerId) return state;
  if (!validPoint(sample)) return {...state, cancelled: true};
  const distance = Math.hypot(sample.x - state.startX, sample.y - state.startY);
  if (!finite(distance)) return {...state, cancelled: true};
  return {...state, maxDistance: Math.max(state.maxDistance, distance)};
}
export function endPointerGesture(state, sample, {cancelled = false} = {}) {
  const empty = {click: false, maxDistance: state?.maxDistance ?? 0, pointer: null};
  if (!state || sample?.pointerId !== state.pointerId) return empty;
  const ended = updatePointerGesture(state, sample);
  return {click: !cancelled && !ended.cancelled && validPoint(sample) && ended.maxDistance <= ended.threshold,
    maxDistance: ended.maxDistance, pointer: validPoint(sample) ? {x: sample.x, y: sample.y} : null};
}
