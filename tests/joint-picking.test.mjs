import test from 'node:test';
import assert from 'node:assert/strict';
import {OrthographicCamera, PerspectiveCamera, Vector3, WebGPUCoordinateSystem} from '../vendor/three.module.js';
import {projectJoints, pickJointCandidates, cycleJointCandidate, beginPointerGesture, updatePointerGesture, endPointerGesture} from '../joint-picking.js';

// Real vendored Three cameras/matrices, no DOM, renderer, assets or GPU.
function fixture(width = 800, height = 400) {
  const aspect = width / height;
  const camera = new OrthographicCamera(-2 * aspect, 2 * aspect, 2, -2, .1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return {camera, width, height};
}
const joint = (id, position = [0, 0, 0], category = 'body') => ({id, position, category});
const ids = candidates => candidates.map(c => c.id);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const event = (x, y, pointerId = 7, extra = {}) => ({x, y, pointerId, ...extra});

for (const [width, height] of [[800, 400], [400, 800], [500, 500]]) {
  test(`CSS projection ${width}x${height} agrees with vendored Vector3.project`, () => {
    const f = fixture(width, height);
    const positions = [[0, 0, 0], [.4, .8, 1], [-.5, -.7, -2]];
    const joints = positions.map((p, i) => joint(i, p));
    const before = {projection: f.camera.projectionMatrix.toArray(), world: f.camera.matrixWorld.toArray(), inverse: f.camera.matrixWorldInverse.toArray()};
    const result = projectJoints({...f, joints});
    assert.equal(result.length, 3);
    result.forEach((candidate, i) => {
      const ndc = new Vector3(...positions[i]).project(f.camera);
      close(candidate.x, (ndc.x + 1) * width / 2);
      close(candidate.y, (1 - ndc.y) * height / 2);
      close(candidate.depth, ndc.z);
      assert.equal(candidate.index, i);
    });
    assert.deepEqual({projection: f.camera.projectionMatrix.toArray(), world: f.camera.matrixWorld.toArray(), inverse: f.camera.matrixWorldInverse.toArray()}, before);
    assert.deepEqual(joints, positions.map((p, i) => joint(i, p)));
  });
}

test('rotated camera, pan and zoom use current matrices, not world XY or cached projection', () => {
  const f = fixture();
  f.camera.position.set(10, 2, 3);
  f.camera.lookAt(0, 2, 3);
  f.camera.zoom = 2;
  f.camera.updateProjectionMatrix();
  f.camera.updateMatrixWorld(true);
  const positions = [[0, 2, 3], [0, 2.5, 3.5]];
  const result = projectJoints({...f, joints: positions.map((p, i) => joint(i, p))});
  close(result[0].x, 400); close(result[0].y, 200);
  close(result[1].x, 300); close(result[1].y, 100);
  result.forEach((c, i) => close(c.depth, new Vector3(...positions[i]).project(f.camera).z));
  f.camera.position.add(new Vector3(0, 1, 1));
  f.camera.lookAt(0, 3, 4);
  f.camera.zoom = .5;
  f.camera.updateProjectionMatrix(); f.camera.updateMatrixWorld(true);
  const p = positions[0], ndc = new Vector3(...p).project(f.camera);
  const moved = projectJoints({...f, joints: [joint('moved', p)]})[0];
  close(moved.x, (ndc.x + 1) * 400); close(moved.y, (1 - ndc.y) * 200);
});

test('layer filter is explicit and independent of skeleton/helper or joint visibility', () => {
  const f = fixture();
  const joints = ['body', 'hands', 'face'].map(category => ({...joint(category, [0, 0, 0], category), visible: false}));
  assert.deepEqual(ids(projectJoints({...f, joints})), ['body', 'hands', 'face']);
  assert.deepEqual(ids(projectJoints({...f, joints, layers: ['hands', 'face']})), ['hands', 'face']);
  assert.deepEqual(projectJoints({...f, joints, layers: []}), []);
  assert.deepEqual(ids(pickJointCandidates({...f, joints, layers: ['body'], pointer: {x: 400, y: 200}})), ['body']);
});

test('finite screen-space radius excludes distant and empty-area hits, including outside pointer', () => {
  const f = fixture();
  const joints = [joint('center'), joint('edge', [.24, 0, 0]), joint('outside-radius', [.241, 0, 0])];
  const hits = pickJointCandidates({...f, joints, pointer: {x: 400, y: 200}});
  assert.deepEqual(ids(hits), ['center', 'edge']);
  close(hits[0].distance, 0); close(hits[1].distance, 24);
  assert.deepEqual(ids(pickJointCandidates({...f, joints, pointer: {x: 400, y: 200}, radius: 0})), ['center']);
  assert.deepEqual(pickJointCandidates({...f, joints, pointer: {x: 200, y: 200}}), []);
  assert.deepEqual(pickJointCandidates({...f, joints, pointer: {x: -1, y: 200}, radius: 1000}), []);
  assert.deepEqual(pickJointCandidates({...f, joints: [], pointer: {x: 400, y: 200}}), []);
});

test('nearest screen distance is stable; depth does not override overlap input ordering', () => {
  const f = fixture();
  const joints = [joint('far', [.2, 0, 0]), joint('first-tie', [0, 0, -1]), joint('second-tie', [0, 0, 1]), joint('near', [.1, 0, 0])];
  const hits = pickJointCandidates({...f, joints, pointer: {x: 400, y: 200}});
  assert.deepEqual(ids(hits), ['first-tie', 'second-tie', 'near', 'far']);
  assert.equal(cycleJointCandidate(hits)?.id, 'first-tie');
  assert.equal(cycleJointCandidate(hits, 'first-tie', {advance: true})?.id, 'second-tie');
  assert.equal(cycleJointCandidate(hits, 'far', {advance: true})?.id, 'first-tie');
  assert.equal(cycleJointCandidate(hits, 'unknown', {advance: true})?.id, 'first-tie');
  assert.equal(cycleJointCandidate(hits, 'near', {advance: false})?.id, 'first-tie');
  assert.equal(cycleJointCandidate([], 'old', {advance: true}), null);
  assert.equal(cycleJointCandidate([hits[0]], hits[0].id, {advance: true}), hits[0]);
  assert.deepEqual(ids(hits), ['first-tie', 'second-tie', 'near', 'far']);
});

test('skips out-of-frustum, behind, sparse, nonfinite and malformed joints without renumbering', () => {
  const f = fixture();
  const sparsePosition = new Array(3); sparsePosition[0] = 0; sparsePosition[2] = 0;
  const joints = new Array(3);
  joints.push(null, undefined, joint('sparse', sparsePosition), joint('nan', [0, NaN, 0]), joint('infinity', [Infinity, 0, 0]), joint('short', [0, 0]), joint('strings', ['0', 0, 0]), joint('unknown', [0, 0, 0], 'other'), joint('behind', [0, 0, 11]), joint('camera-plane', [0, 0, 10]), joint('before-near', [0, 0, 9.95]), joint('beyond-far', [0, 0, -91]), joint('off-left', [-4.01, 0, 0]), joint('off-right', [4.01, 0, 0]), joint('off-top', [0, 2.01, 0]), joint('off-bottom', [0, -2.01, 0]), {...joint(undefined)}, joint('valid'));
  const result = projectJoints({...f, joints});
  assert.deepEqual(ids(result), ['valid']);
  assert.equal(result[0].index, joints.length - 1);
});

test('frustum and viewport edges are inclusive; near/far clipping is honored', () => {
  const f = fixture();
  const result = projectJoints({...f, joints: [joint('left', [-4, 0, 0]), joint('right', [4, 0, 0]), joint('top', [0, 2, 0]), joint('bottom', [0, -2, 0]), joint('near', [0, 0, 9.9]), joint('far', [0, 0, -90])]});
  assert.deepEqual(ids(result), ['left', 'right', 'top', 'bottom', 'near', 'far']);
  close(result[0].x, 0); close(result[1].x, 800); close(result[2].y, 0); close(result[3].y, 400);
  close(result[4].depth, -1); close(result[5].depth, 1);
});

test('invalid configuration rejects rather than silently selecting anything', () => {
  const args = {...fixture(), joints: []};
  for (const width of [0, -1, Infinity, NaN, '800']) assert.throws(() => projectJoints({...args, width}), TypeError);
  for (const height of [0, Infinity]) assert.throws(() => projectJoints({...args, height}), TypeError);
  for (const camera of [null, {}, new PerspectiveCamera()]) assert.throws(() => projectJoints({...args, camera}), TypeError);
  assert.throws(() => projectJoints({...args, joints: {}}), TypeError);
  assert.throws(() => projectJoints({...args, layers: ['unknown']}), TypeError);
  assert.throws(() => projectJoints({...args, layers: 'body'}), TypeError);
  for (const radius of [-1, Infinity, NaN, '24']) assert.throws(() => pickJointCandidates({...args, radius, pointer: {x: 0, y: 0}}), TypeError);
  for (const pointer of [null, {}, {x: Infinity, y: 0}]) assert.throws(() => pickJointCandidates({...args, pointer}), TypeError);
  args.camera.matrixWorldInverse.elements[0] = NaN;
  assert.throws(() => projectJoints(args), TypeError);
});

test('WebGPU/non-WebGL coordinate systems reject explicitly rather than mis-clipping', () => {
  const f = fixture(); f.camera.coordinateSystem = WebGPUCoordinateSystem; f.camera.updateProjectionMatrix();
  assert.throws(() => projectJoints({...f, joints: []}), TypeError);
});

test('pointer short movement and exact threshold count as clicks; state stays immutable', () => {
  const state = beginPointerGesture(event(10, 20), {threshold: 5});
  const moved = updatePointerGesture(state, event(13, 24));
  assert.notEqual(moved, state);
  assert.equal(state.maxDistance, 0);
  close(moved.maxDistance, 5);
  assert.deepEqual(endPointerGesture(moved, event(10, 20)), {click: true, maxDistance: 5, pointer: {x: 10, y: 20}});
  assert.equal(endPointerGesture(beginPointerGesture(event(0, 0)), event(1, 1)).click, true);
});

test('drag returning to start is never a click and final-up displacement is sampled', () => {
  const initial = beginPointerGesture(event(0, 0));
  const away = updatePointerGesture(initial, event(20, 0));
  const back = updatePointerGesture(away, event(0, 0));
  assert.equal(endPointerGesture(back, event(0, 0)).click, false);
  assert.equal(back.maxDistance, 20);
  assert.equal(endPointerGesture(initial, event(6, 0)).click, false);
});

test('cancel, wrong pointer, right button and secondary pointer cannot select', () => {
  const state = beginPointerGesture(event(0, 0));
  assert.equal(endPointerGesture(state, event(0, 0), {cancelled: true}).click, false);
  assert.equal(endPointerGesture(state, {pointerId: 7}, {cancelled: true}).click, false);
  assert.equal(endPointerGesture(state, event(0, 0, 8)).click, false);
  assert.equal(updatePointerGesture(state, event(100, 100, 8)), state);
  assert.equal(beginPointerGesture(event(0, 0, 7, {button: 2})), null);
  assert.equal(beginPointerGesture(event(0, 0, 7, {isPrimary: false})), null);
  assert.equal(endPointerGesture(null, event(0, 0)).click, false);
  assert.equal(updatePointerGesture(null, event(0, 0)), null);
  // Bad samples fail closed instead of resurrecting a click at pointerup.
  const invalid = updatePointerGesture(state, event(NaN, 0));
  assert.equal(endPointerGesture(invalid, event(0, 0)).click, false);
  assert.equal(endPointerGesture(state, event(Infinity, 0)).click, false);
});

test('gesture options and start coordinates are validated; zero threshold works', () => {
  for (const threshold of [-1, Infinity, NaN, '5']) assert.throws(() => beginPointerGesture(event(0, 0), {threshold}), TypeError);
  assert.throws(() => beginPointerGesture(event(NaN, 0)), TypeError);
  const state = beginPointerGesture(event(0, 0), {threshold: 0});
  assert.equal(endPointerGesture(state, event(0, 0)).click, true);
  assert.equal(endPointerGesture(state, event(.01, 0)).click, false);
});
