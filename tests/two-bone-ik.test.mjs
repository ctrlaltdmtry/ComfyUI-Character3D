import test from 'node:test';
import assert from 'node:assert/strict';
import {solveTwoBoneIK} from '../two-bone-ik.js';

const base = {root: [0, 0, 0], target: [3, 0, 0], pole: [0, 4, 0], length1: 2, length2: 2};
const sub = (a, b) => a.map((x, i) => x - b[i]);
const distance = (a, b) => Math.hypot(...sub(a, b));
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const near = (a, b, epsilon = 1e-10) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
const vectorNear = (a, b, epsilon) => a.forEach((x, i) => near(x, b[i], epsilon));
function finiteJSON(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value));
  else if (Array.isArray(value)) value.forEach(finiteJSON);
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteJSON);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}
function verify(input, result = solveTwoBoneIK(input), epsilon = 1e-10) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.error, null);
  near(distance(result.elbow, input.root), input.length1, epsilon);
  near(distance(result.end, result.elbow), input.length2, epsilon);
  near(distance(result.end, input.root), result.diagnostics.solvedDistance, epsilon);
  near(distance(result.end, input.target), result.diagnostics.targetError, epsilon);
  for (const v of Object.values(result.bendInfo)) near(Math.hypot(...v), 1);
  near(dot(result.bendInfo.direction, result.bendInfo.bendDirection), 0);
  vectorNear(cross(result.bendInfo.direction, result.bendInfo.bendDirection), result.bendInfo.planeNormal);
  if (!result.diagnostics.unreachable) vectorNear(result.end, input.target, epsilon);
  finiteJSON(result);
  return result;
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test('reachable elbow follows the pole and conserves both segments', () => {
  const result = verify(base);
  near(result.elbow[0], 1.5);
  near(result.elbow[1], Math.sqrt(1.75));
  assert.equal(result.diagnostics.bendSource, 'pole');
  assert.equal(result.diagnostics.reach, 'reachable');
  assert.equal(result.diagnostics.clamped, false);
});

test('unequal segments use the analytic elbow, including a backwards first segment', () => {
  const result = verify({...base, length1: 3, length2: 2});
  near(result.elbow[0], 7 / 3);
  const backwards = verify({...base, target: [1.1, 0, 0], length1: 2, length2: 3});
  assert.ok(backwards.elbow[0] < 0);
});

test('exact outer and inner limits are reachable, finite and singular', () => {
  for (const [length1, length2] of [[3, 2], [2, 3], [2, 2]]) {
    for (const d of [length1 + length2, Math.abs(length1 - length2)]) {
      const result = verify({...base, length1, length2, target: [d, 0, 0]});
      assert.equal(result.diagnostics.reach, 'reachable');
      assert.equal(result.diagnostics.singular, true);
      assert.equal(result.diagnostics.clamped, false);
    }
  }
});

test('outer unreachable target clamps without stretching', () => {
  const result = verify({...base, target: [9, 0, 0], length1: 3, length2: 2});
  vectorNear(result.end, [5, 0, 0]);
  assert.equal(result.diagnostics.reach, 'outer');
  assert.equal(result.diagnostics.unreachable, true);
  assert.equal(result.diagnostics.clamped, true);
  near(result.diagnostics.targetError, 4);
});

test('inner unreachable targets clamp for either ordering of segment lengths', () => {
  for (const [length1, length2] of [[3, 1], [1, 3]]) {
    const result = verify({...base, length1, length2, target: [0.01, 0, 0]});
    vectorNear(result.end, [2, 0, 0]);
    near(result.elbow[0], length1 > length2 ? length1 : -length1);
    assert.equal(result.diagnostics.reach, 'inner');
    assert.equal(result.diagnostics.clamped, true);
  }
});

test('target at root uses explicit prior direction and bend; equal lengths fold exactly', () => {
  const input = {...base, target: [0, 0, 0], previousDirection: [0, 0, 2], previousBend: [0, -5, 0]};
  const result = verify(input);
  vectorNear(result.elbow, [0, -2, 0]);
  vectorNear(result.end, input.root);
  assert.equal(result.diagnostics.targetAtRoot, true);
  assert.equal(result.diagnostics.directionSource, 'previous');
  assert.equal(result.diagnostics.bendSource, 'previous');
});

test('unequal lengths at root retain direction and cannot fabricate root reach', () => {
  for (const [length1, length2] of [[3, 1], [1, 3]]) {
    const result = verify({...base, length1, length2, target: [0, 0, 0], preferredDirection: [0, 0, -1]});
    vectorNear(result.end, [0, 0, -2]);
    assert.equal(result.diagnostics.reach, 'inner');
    assert.equal(result.diagnostics.directionSource, 'preferred');
  }
});

test('parallel, antiparallel and coincident pole use projected prior bend', () => {
  for (const pole of [[8, 0, 0], [-8, 0, 0], [0, 0, 0], [8, 1e-12, 0]]) {
    const result = verify({...base, pole, previousBend: [10, 0, -4]});
    vectorNear(result.bendInfo.bendDirection, [0, 0, -1]);
    assert.equal(result.diagnostics.poleDegenerate, true);
    assert.equal(result.diagnostics.bendSource, 'previous');
  }
});

test('degenerate prior falls back to preferred bend, then deterministic canonical axis', () => {
  const input = {...base, pole: [0, 0, 0], previousBend: [1, 0, 0], preferredBend: [0, -1, 0]};
  const preferred = verify(input);
  assert.equal(preferred.diagnostics.bendSource, 'preferred');
  vectorNear(preferred.bendInfo.bendDirection, [0, -1, 0]);
  const canonicalInput = {...input, preferredBend: [0, 0, 0]};
  const canonical = verify(canonicalInput);
  assert.equal(canonical.diagnostics.bendSource, 'canonical');
  vectorNear(canonical.bendInfo.bendDirection, [0, 1, 0]);
  assert.deepEqual(solveTwoBoneIK(canonicalInput), canonical);
});

test('a nondegenerate pole takes precedence over prior/preferred bend away from root', () => {
  const result = verify({...base, previousBend: [0, -1, 0], preferredBend: [0, 0, 1]});
  assert.equal(result.diagnostics.bendSource, 'pole');
  assert.ok(result.elbow[1] > 0);
});

test('prior bend transports continuously through singular frames with reproducible results', () => {
  let result = verify({...base, pole: [0, 0, -3]});
  for (const target of [[3, 0.001, 0], [4, 0.002, 0], [6, 0.003, 0], [0, 0, 0], [3, 0, 0]]) {
    const input = {...base, target, pole: [...target], previousBend: result.bendInfo.bendDirection, previousDirection: result.bendInfo.direction};
    const next = verify(input);
    assert.ok(dot(next.bendInfo.bendDirection, result.bendInfo.bendDirection) > 0.999);
    assert.deepEqual(solveTwoBoneIK(input), next);
    result = next;
  }
});

test('rotations and translations preserve pole/prior selected geometry in arbitrary frames', () => {
  const axis = [2 / 3, -1 / 3, 2 / 3], angle = 1.37;
  const rotate = v => {
    const c = Math.cos(angle), s = Math.sin(angle), k = dot(axis, v), w = cross(axis, v);
    return v.map((x, i) => x * c + w[i] * s + axis[i] * k * (1 - c));
  };
  const shift = [17.2, -43.7, 9.8];
  const point = v => rotate(v).map((x, i) => x + shift[i]);
  for (const input of [base, {...base, target: [0.1, 0, 0], length1: 3, length2: 1}, {...base, pole: [6, 0, 0], previousBend: [0, 0, -1]}, {...base, target: [0, 0, 0], previousDirection: [0, 1, 0], preferredBend: [0, 0, 1]}]) {
    const original = verify(input);
    const transformed = {...input, root: point(input.root), target: point(input.target), pole: point(input.pole)};
    for (const field of ['previousBend', 'previousDirection', 'preferredBend']) if (input[field]) transformed[field] = rotate(input[field]);
    const result = verify(transformed);
    vectorNear(result.elbow, point(original.elbow));
    vectorNear(result.end, point(original.end));
    vectorNear(result.bendInfo.bendDirection, rotate(original.bendInfo.bendDirection));
  }
});

test('very small reachable displacement does not discard target direction', () => {
  const result = verify({...base, target: [0, 0, 1e-15], length1: 1, length2: 1});
  assert.equal(result.diagnostics.targetAtRoot, false);
  vectorNear(result.bendInfo.direction, [0, 0, 1]);
  assert.equal(result.end[2], 1e-15);
});

test('uniform tiny and large scales remain finite and conserve both lengths', () => {
  for (const scale of [1e-150, 1e-30, 1e30, 1e150]) {
    const input = {...base, root: [scale, -scale, scale], target: [4 * scale, -scale, scale], pole: [scale, 3 * scale, scale], length1: 2 * scale, length2: 2 * scale};
    const result = verify(input, solveTwoBoneIK(input), 1e-12 * scale);
    near(distance(result.elbow, input.root) / scale, 2);
    near(distance(result.end, result.elbow) / scale, 2);
  }
});

test('seeded CPU fixtures conserve lengths and agree with target over general frames', () => {
  let seed = 0x73ab29;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const vector = () => Array.from({length: 3}, () => (random() - 0.5) * 20);
  for (let i = 0; i < 1500; i++) {
    const input = {root: vector(), target: vector(), pole: vector(), length1: 0.1 + 15 * random(), length2: 0.1 + 15 * random()};
    verify(input);
  }
});

test('inputs are immutable and all returned arrays are detached', () => {
  const input = deepFreeze({...base, root: [...base.root], target: [...base.target], pole: [...base.pole], previousBend: [0, 1, 0]});
  const before = JSON.stringify(input), result = verify(input);
  result.elbow[0] = 100; result.end[0] = 100; result.bendInfo.direction[0] = 100;
  assert.equal(JSON.stringify(input), before);
  verify(input);
});

test('malformed records, nonfinite/nonpositive lengths and sparse vectors return explicit errors', () => {
  const bad = [undefined, null, [], 3, 'input', false];
  for (const field of ['length1', 'length2']) for (const value of [0, -1, NaN, Infinity, -Infinity, undefined, null, '2', true]) bad.push({...base, [field]: value});
  for (const field of ['root', 'target', 'pole', 'previousBend', 'preferredBend', 'previousDirection', 'preferredDirection']) {
    for (const value of [undefined, null, {}, 'xyz', [1, 2], [1, 2, 3, 4], [1, NaN, 3], [1, Infinity, 3], [1, , 3], Array(3), ['1', 2, 3]]) bad.push({...base, [field]: value});
  }
  for (const field of ['root', 'target', 'pole', 'length1', 'length2']) { const input = {...base}; delete input[field]; bad.push(input); }
  for (const input of bad) {
    const result = solveTwoBoneIK(input);
    assert.equal(result.ok, false);
    assert.equal(result.elbow, null); assert.equal(result.end, null); assert.equal(result.bendInfo, null);
    assert.equal(result.error.code, 'INVALID_INPUT');
    assert.equal(typeof result.error.field, 'string');
    finiteJSON(result);
  }
});

function verifyStrictLengths(input) {
  const result = verify(input, solveTwoBoneIK(input), 512 * Number.EPSILON * Math.max(input.length1, input.length2));
  for (const [actual, expected] of [
    [distance(result.elbow, input.root), input.length1],
    [distance(result.end, result.elbow), input.length2],
    [distance(result.end, input.root), result.diagnostics.solvedDistance],
  ]) near(actual, expected, Math.max(Number.MIN_VALUE, 512 * Number.EPSILON * expected));
  return result;
}

test('unequal near-reach regressions conserve both lengths at the public strict tolerance', () => {
  for (const [length1, length2] of [[100, 1], [1, 100]]) {
    for (const d of [99.0000000001, 99.00000001, 99.000001, 99.0001, 100.999999999999, 100.9999999999, 100.999999]) {
      const input = {...base, length1, length2, target: [d, 0, 0]};
      const result = verifyStrictLengths(input);
      assert.equal(result.diagnostics.reach, 'reachable');
      assert.equal(result.diagnostics.singular, false);
      assert.ok(result.elbow[1] > 0, 'strictly interior triangle must not snap flat');
      // Independent ordinary-range factored Heron reference: compare height,
      // not just success flags, and avoid subtracting nearly equal squares.
      const outer = (100 - d) + 1, inner = (d - 100) + 1;
      const expectedHeight = Math.sqrt((101 + d) * outer * (d + 99) * inner) / (2 * d);
      near(result.elbow[1], expectedHeight, 64 * Number.EPSILON * expectedHeight);
    }
  }
});

test('nearly equal lengths retain the analytic axial offset near inner reach', () => {
  for (const [length1, length2] of [[1.000001, 1], [1, 1.000001]]) {
    const lo = Math.abs(length1 - length2);
    for (const relative of [1e-15, 1e-14, 1e-12, 1e-10, 1e-8, 1e-6]) {
      const d = lo + relative * Math.max(length1, length2);
      const result = verifyStrictLengths({...base, length1, length2, target: [d, 0, 0]});
      const expectedAlong = d / 2 + (length1 - length2) * (length1 + length2) / (2 * d);
      near(result.elbow[0], expectedAlong, 64 * Number.EPSILON * Math.max(length1, length2));
      assert.equal(result.diagnostics.singular, false);
    }
  }
});

test('boundary grid retains exact closed reach classification and strict lengths', () => {
  let checked = 0;
  for (const [length1, length2] of [[1, 1], [1.000001, 1], [1, 1.000001], [2, 1], [1, 2], [100, 1], [1, 100]]) {
    const lo = Math.abs(length1 - length2), hi = length1 + length2;
    for (const boundary of [lo, hi]) {
      for (const relative of [0, 1e-15, -1e-15, 1e-14, -1e-14, 1e-12, -1e-12, 1e-10, -1e-10, 1e-8, -1e-8, 1e-6, -1e-6]) {
        const d = Math.max(0, boundary + relative * Math.max(length1, length2));
        const result = verifyStrictLengths({...base, length1, length2, target: [d, 0, 0]});
        const expectedReach = d < lo ? 'inner' : d > hi ? 'outer' : 'reachable';
        const solved = Math.min(hi, Math.max(lo, d));
        assert.equal(result.diagnostics.reach, expectedReach);
        assert.equal(result.diagnostics.clamped, expectedReach !== 'reachable');
        assert.equal(result.diagnostics.singular, solved === lo || solved === hi || d === 0);
        if (d > lo && d < hi) assert.ok(result.elbow[1] > 0, 'no epsilon boundary snap');
        if (d !== 0 && (d === lo || d === hi)) assert.equal(result.elbow[1], 0);
        checked++;
      }
    }
  }
  assert.equal(checked, 182);
});

test('near-boundary geometry remains strict across scales and non-axis-aligned directions', () => {
  let checked = 0;
  for (const scale of [1e-150, 1e-30, 1, 1e30, 1e150]) {
    for (const [a, b] of [[100, 1], [1, 100], [1.000001, 1], [1, 1.000001]]) {
      const length1 = a * scale, length2 = b * scale;
      for (const boundary of [Math.abs(length1 - length2), length1 + length2]) {
        for (const relative of [1e-12, -1e-12, 1e-8, -1e-8]) {
          const d = boundary + relative * Math.max(length1, length2);
          for (const direction of [[1, 0, 0], [0.6, 0.8, 0]]) {
            const input = {root: [0, 0, 0], target: direction.map(x => x * d), pole: [0, 0, scale], length1, length2};
            const result = verifyStrictLengths(input);
            const requested = Math.hypot(...input.target);
            assert.equal(result.diagnostics.reach, requested < Math.abs(length1 - length2) ? 'inner' : requested > length1 + length2 ? 'outer' : 'reachable');
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 320);
  // Factored products must not underflow to zero when distance itself is tiny.
  for (const [length, d] of [[1, Number.MIN_VALUE], [1, 1e-300], [1e150, 1e-150]]) {
    const result = verifyStrictLengths({...base, length1: length, length2: length, target: [d, 0, 0]});
    assert.equal(result.diagnostics.targetAtRoot, false);
    assert.equal(result.diagnostics.singular, false);
    assert.ok(result.elbow[1] > 0);
  }
});

test('representational overflow/underflow/precision loss are diagnosed, never invalid geometry', () => {
  const inputs = [
    {...base, length1: Number.MAX_VALUE, length2: Number.MAX_VALUE},
    {...base, root: [-Number.MAX_VALUE, 0, 0], target: [Number.MAX_VALUE, 0, 0]},
    {...base, length1: Number.MIN_VALUE, length2: 1e300},
    {...base, root: [1e100, 1e100, 1e100], target: [1e100, 1e100, 1e100], pole: [1e100, 1e100, 1e100]},
  ];
  for (const input of inputs) {
    const result = solveTwoBoneIK(input);
    assert.equal(result.ok, false);
    assert.ok(['NUMERIC_RANGE', 'PRECISION_LOSS'].includes(result.error.code));
    assert.equal(result.elbow, null); assert.equal(result.end, null);
    finiteJSON(result);
  }
});
