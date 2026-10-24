/**
 * CPU-only analytic two-segment IK geometry. No Three.js, joint rotations,
 * anatomical assumptions, joint limits, hierarchy changes or input mutation.
 *
 * Public API: solveTwoBoneIK({
 *   root, target, pole, length1, length2,
 *   previousBend?, preferredBend?, previousDirection?, preferredDirection?
 * })
 *
 * root/target/pole: dense arrays of exactly three finite numbers, all POINTS in
 * the SAME coordinate frame. length1/length2: finite numbers strictly > 0 in
 * that frame's units. Optional fields are finite 3-vectors, not points; they
 * need not be unit vectors. Zero/parallel hints are valid but unusable. Explicit
 * undefined/null fields are invalid. Transform world points into actor-local
 * coordinates (and directions as directions) before solving if desired; this
 * API itself neither transforms frames nor supports nonuniform scaled metrics.
 *
 * Direction is target-root, except at EXACT zero displacement: previousDirection,
 * then preferredDirection, then +X. A nonzero displacement, however small, is
 * never replaced by a fallback. Pole bend is the projection of pole-root into
 * the plane perpendicular to direction. When its relative perpendicular length
 * is <= 1e-10, use projected previousBend, preferredBend, then the least-aligned
 * Cartesian axis (X/Y/Z tie order). At target=root the bend priority instead is
 * previousBend, preferredBend, pole, canonical, retaining caller-provided state.
 * This is deterministic, not a promise of globally continuous bending across
 * conflicting poles. Fallback projections use the same 1e-10 angular threshold.
 *
 * Success (plain JSON, fresh arrays):
 * {
 *   ok: true, elbow: [x,y,z], end: [x,y,z], error: null,
 *   bendInfo: {direction, bendDirection, planeNormal}, // unit vectors
 *   diagnostics: {
 *     requestedDistance, solvedDistance, minReach, maxReach, targetError,
 *     reach: 'reachable'|'inner'|'outer', clamped, unreachable,
 *     targetAtRoot, poleDegenerate, singular,
 *     directionSource: 'target'|'previous'|'preferred'|'canonical',
 *     bendSource: 'pole'|'previous'|'preferred'|'canonical'
 *   }
 * }
 * Pass bendInfo.bendDirection as next previousBend and bendInfo.direction as
 * next previousDirection; keep them in the same frame as the next solve. Even
 * at straight/folded singularities these unit vectors remain reusable, though
 * the elbow need not have a perpendicular offset.
 *
 * Reach is the CLOSED interval [abs(length1-length2), length1+length2]. Outside
 * it, end is radially clamped WITHOUT stretching. Unequal lengths at target=root
 * therefore use the fallback direction and do not reach root. Equal lengths at
 * root fold with elbow=root+bend*length1. Exact bounds are reachable. No epsilon
 * snap of reach or target direction is performed. singular means an exact reach
 * boundary or target=root, not a biomechanical singularity classification.
 *
 * Failure: {ok:false, elbow:null, end:null, bendInfo:null, diagnostics:null,
 *   error:{code:'INVALID_INPUT'|'NUMERIC_RANGE'|'PRECISION_LOSS', field, message}}.
 * Invalid inputs return errors, not invented zero geometry. Finite IEEE-754
 * inputs can still exceed representable subtraction/sum/geometry ranges or
 * lose short segments in large translated coordinates; these cases fail
 * explicitly. Returned segment lengths are checked to 512*Number.EPSILON
 * relative error (one subnormal ULP minimum). No NaN/Infinity are returned.
 * Legitimate coordinate zeros and coincident end/root are of course permitted.
 * Inputs are ordinary data records/arrays; hostile getters/proxies are outside
 * this JSON API contract. No actual joint-angle clamping is performed here.
 */

const ANGULAR_EPSILON = 1e-10;
const LENGTH_EPSILON = 512 * Number.EPSILON;
const vectorFields = ['root', 'target', 'pole', 'previousBend', 'preferredBend', 'previousDirection', 'preferredDirection'];
const required = new Set(['root', 'target', 'pole']);
const clean = v => v.map(x => x === 0 ? 0 : x);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = (a, b) => clean([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
const finite = v => v.every(Number.isFinite);
const magnitude = v => Math.hypot(...v);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function failure(code, field, message) {
  return {ok: false, elbow: null, end: null, bendInfo: null, diagnostics: null, error: {code, field, message}};
}

// Rescaling avoids overflow/underflow when normalizing finite hint vectors.
function unit(v) {
  const scale = Math.max(...v.map(Math.abs));
  if (scale === 0) return null;
  const scaled = v.map(x => x / scale);
  const length = magnitude(scaled);
  return clean(scaled.map(x => x / length));
}

function perpendicular(v, direction) {
  const normalized = unit(v);
  if (!normalized) return null;
  // Double cross is more stable than v - dot(v,d)*d for almost parallel v.
  const projected = cross(direction, cross(normalized, direction));
  if (magnitude(projected) <= ANGULAR_EPSILON) return null;
  return unit(projected);
}

function canonicalBend(direction) {
  let index = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(direction[i]) < Math.abs(direction[index])) index = i;
  return perpendicular([0, 1, 2].map(i => i === index ? 1 : 0), direction);
}

/** @see module documentation for exact input/output and fallback contracts. */
export function solveTwoBoneIK(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return failure('INVALID_INPUT', 'input', 'Expected a data record.');
  }
  for (const field of vectorFields) {
    if (!required.has(field) && !owns(input, field)) continue;
    const v = input[field];
    if (!Array.isArray(v) || v.length !== 3 || ![0, 1, 2].every(i => owns(v, i) && typeof v[i] === 'number' && Number.isFinite(v[i]))) {
      return failure('INVALID_INPUT', field, 'Expected a dense array of exactly three finite numbers.');
    }
  }
  for (const field of ['length1', 'length2']) {
    if (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field] <= 0) {
      return failure('INVALID_INPUT', field, 'Expected a finite, strictly positive segment length.');
    }
  }

  const {root, target, pole, length1, length2} = input;
  const offset = sub(target, root), poleOffset = sub(pole, root);
  const requestedDistance = magnitude(offset);
  const minReach = Math.abs(length1 - length2), maxReach = length1 + length2;
  if (!finite(offset) || !finite(poleOffset) || !Number.isFinite(requestedDistance) || !Number.isFinite(maxReach)) {
    return failure('NUMERIC_RANGE', 'geometry', 'Coordinate differences, target distance or reach exceed the finite numeric range.');
  }

  const targetAtRoot = requestedDistance === 0;
  let direction, directionSource;
  if (!targetAtRoot) { direction = unit(offset); directionSource = 'target'; }
  else {
    for (const [field, source] of [['previousDirection', 'previous'], ['preferredDirection', 'preferred']]) {
      if (owns(input, field)) direction = unit(input[field]);
      if (direction) { directionSource = source; break; }
    }
    if (!direction) { direction = [1, 0, 0]; directionSource = 'canonical'; }
  }

  const poleBend = perpendicular(poleOffset, direction);
  const previous = owns(input, 'previousBend') ? perpendicular(input.previousBend, direction) : null;
  const preferred = owns(input, 'preferredBend') ? perpendicular(input.preferredBend, direction) : null;
  const candidates = targetAtRoot
    ? [[previous, 'previous'], [preferred, 'preferred'], [poleBend, 'pole']]
    : [[poleBend, 'pole'], [previous, 'previous'], [preferred, 'preferred']];
  let bendDirection, bendSource;
  for (const [candidate, source] of candidates) {
    if (candidate) { bendDirection = candidate; bendSource = source; break; }
  }
  if (!bendDirection) { bendDirection = canonicalBend(direction); bendSource = 'canonical'; }
  const planeNormal = unit(cross(direction, bendDirection));

  const reach = requestedDistance > maxReach ? 'outer' : requestedDistance < minReach ? 'inner' : 'reachable';
  const solvedDistance = Math.min(maxReach, Math.max(minReach, requestedDistance));
  const scale = Math.max(length1, length2);
  const a = length1 / scale, b = length2 / scale, c = solvedDistance / scale;
  if (a === 0 || b === 0 || (solvedDistance !== 0 && c === 0)) {
    return failure('NUMERIC_RANGE', 'lengths', 'Segment ratios underflow the representable range.');
  }

  let along, height;
  if (solvedDistance === 0) { along = 0; height = a; }
  else if (solvedDistance === maxReach) { along = a; height = 0; }
  else if (solvedDistance === minReach) { along = length1 >= length2 ? a : -a; height = 0; }
  else {
    // Preserve the original length difference before division: subtracting a-b
    // instead loses relative accuracy for nearly equal lengths and small reach.
    along = 0.5 * (c + ((length1 - length2) / solvedDistance) * (a + b));
    // Kahan's factored Heron area with sorted ORIGINAL sides x >= y >= z.
    // Its small factor z-(x-y) retains the distance to a reach boundary; unlike
    // a-along it does not subtract a rounded cosine projection from a length.
    // Divide the two small factors by distance before taking square roots, and
    // the large ones by scale. This avoids squared ranges/product underflow,
    // including equal lengths at extremely small nonzero target distances.
    const [x, y, z] = [length1, length2, solvedDistance].sort((u, v) => v - u);
    const difference = x - y;
    height = 0.5 * Math.sqrt(x / scale + (y / scale + z / scale))
      * Math.sqrt((z - difference) / solvedDistance)
      * Math.sqrt(z / solvedDistance + difference / solvedDistance)
      * Math.sqrt(x / scale + (y - z) / scale);
  }
  const alongWorld = along * scale, heightWorld = height * scale;
  const elbow = clean(root.map((x, i) => x + (direction[i] * alongWorld + bendDirection[i] * heightWorld)));
  // Preserve the exact input target on reachable solves, rather than introducing
  // a second rounding via root + unit(target-root)*distance.
  const end = reach === 'reachable' ? clean([...target])
    : clean(root.map((x, i) => x + direction[i] * solvedDistance));
  const segment1 = magnitude(sub(elbow, root)), segment2 = magnitude(sub(end, elbow));
  const actualDistance = magnitude(sub(end, root)), targetError = magnitude(sub(end, target));
  if (!finite(elbow) || !finite(end) || ![segment1, segment2, actualDistance, targetError].every(Number.isFinite)) {
    return failure('NUMERIC_RANGE', 'geometry', 'Solved positions or diagnostics exceed the finite numeric range.');
  }
  const close = (actual, expected) => Math.abs(actual - expected) <= Math.max(Number.MIN_VALUE, LENGTH_EPSILON * expected);
  if (segment1 === 0 || segment2 === 0 || !close(segment1, length1) || !close(segment2, length2) || !close(actualDistance, solvedDistance)) {
    return failure('PRECISION_LOSS', 'geometry', 'The chosen coordinate frame cannot represent the solved segment lengths within numeric tolerance.');
  }

  return {
    ok: true, elbow, end, error: null,
    bendInfo: {direction, bendDirection, planeNormal},
    diagnostics: {
      requestedDistance, solvedDistance, minReach, maxReach, targetError,
      reach, clamped: reach !== 'reachable', unreachable: reach !== 'reachable',
      targetAtRoot, poleDegenerate: poleBend === null,
      singular: targetAtRoot || solvedDistance === minReach || solvedDistance === maxReach,
      directionSource, bendSource,
    },
  };
}
