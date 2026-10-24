import test from 'node:test';
import assert from 'node:assert/strict';
import {OrthographicCamera, Vector3, Spherical, EventDispatcher} from '../vendor/three.module.js';
import {createCameraController} from '../camera-controller.js';
import {readFile} from 'node:fs/promises';

// Load the unmodified vendored OrbitControls for DOM-free CPU coverage, rewriting
// only its browser import-map specifier in memory. No vendored file is changed.
async function cpuOrbitControls() {
  const source = await readFile(new URL('../vendor/OrbitControls.js', import.meta.url), 'utf8');
  assert.ok(source.includes("from 'three'"));
  const localThree = new URL('../vendor/three.module.js', import.meta.url).href;
  return (await import('data:text/javascript;base64,' + Buffer.from(source.replace("from 'three'", `from '${localThree}'`)).toString('base64'))).OrbitControls;
}

// CPU-only minimal controls harness, NOT a browser/OrbitControls integration test.
// Actual vendored Three.js cameras, matrices, quaternions and spherical math run here.
class ControlsHarness extends EventDispatcher {
  constructor(camera) { super(); this.object = camera; this.target = new Vector3(); this.updates = 0; }
  update() {
    this.updates++;
    // OrbitControls' spherical round trip introduces legitimate floating-point noise.
    const offset = this.object.position.clone().sub(this.target);
    offset.setFromSpherical(new Spherical().setFromVector3(offset));
    this.object.position.copy(this.target).add(offset);
    this.object.lookAt(this.target);
    this.object.updateMatrixWorld(true);
    this.dispatchEvent({type: 'change'});
  }
  move(position, target, zoom = this.object.zoom) {
    this.object.position.fromArray(position); this.target.fromArray(target); this.object.zoom = zoom;
    this.object.updateProjectionMatrix(); this.update();
  }
}
const view = () => ({position: [1.23456789, 3.45678912, 8.98765432], target: [.12, 1.78, -.34], zoom: 1.23456789, height: 5.67891234});
const other = () => ({position: [-7, 4, 6], target: [2, 1, -1], zoom: 2.25, height: 8});
const editor = (cameraMode, viewport = other()) => ({schema: 'character-3d-editor/1', cameraMode, viewport});
function fixture(v = view()) {
  const camera = new OrthographicCamera(-1, 1, 1, -1, .01, 1000);
  const controls = new ControlsHarness(camera);
  let vp = {width: 1200, height: 600}, out = {width: 600, height: 1200};
  const notices = [];
  const controller = createCameraController({camera, controls, viewport: () => vp, output: () => out, changed: kind => notices.push(kind)});
  controller.initialize(v);
  return {camera, controls, notices, controller, setViewport: value => {vp = value;}, setOutput: value => {out = value;}};
}
function close(a, b, message = '') { assert.ok(Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b)), `${message}: ${a} != ${b}`); }
function cameraSnapshot(c) { return {position: c.position.toArray(), quaternion: c.quaternion.toArray(), up: c.up.toArray(), zoom: c.zoom, left: c.left, right: c.right, top: c.top, bottom: c.bottom, near: c.near, far: c.far, projection: c.projectionMatrix.toArray()}; }

test('API has the requested methods; initialization clones both legacy views silently', () => {
  const input = view(), f = fixture(input), c = f.controller;
  for (const method of ['initialize','mode','setMode','renderState','editorState','setRender','setEditor','setActive','resized','capture','outputCamera','frame','dispose']) assert.equal(typeof c[method], 'function', method);
  assert.equal(c.mode(), true);
  assert.deepEqual(c.renderState(), input);
  assert.deepEqual(c.editorState(), editor(true, input));
  assert.deepEqual(f.notices, []);
  input.position[0] = 100; input.target[0] = 100;
  assert.deepEqual(c.renderState(), view());
});

test('mode round trips preserve exact descriptors through synthetic controls changes', () => {
  const f = fixture(), initial = f.controller.renderState(), sameCamera = f.camera;
  for (let i = 0; i < 30; i++) { f.controller.setMode(false); f.controls.update(); f.controller.capture(); f.controller.setMode(true); }
  assert.equal(f.camera, sameCamera); assert.equal(f.controls.object, sameCamera);
  assert.deepEqual(f.controller.renderState(), initial);
  assert.deepEqual(f.controller.editorState().viewport, initial);
  assert.ok(f.notices.every(k => k === 'editor'));
  assert.equal(f.notices.length, 60);
});

test('free orbit/pan/zoom changes editor only and camera mode restores render', () => {
  const f = fixture(), c = f.controller, initial = c.renderState(); c.setMode(false); f.notices.length = 0;
  f.controls.move(other().position, other().target, other().zoom);
  assert.deepEqual(c.renderState(), initial);
  const nav = c.editorState().viewport;
  nav.position.forEach((x, i) => close(x, other().position[i]));
  assert.deepEqual(nav.target, other().target); assert.equal(nav.zoom, 2.25); assert.equal(nav.height, initial.height);
  assert.deepEqual(f.notices, ['editor']);
  c.setMode(true); assert.deepEqual(c.renderState(), initial);
  initial.position.forEach((x, i) => close(f.camera.position.getComponent(i), x));
  c.setMode(false); assert.deepEqual(c.editorState().viewport, nav);
});

test('camera-mode changes emit render and capture undoes portrait letterbox factor', () => {
  const f = fixture(), c = f.controller, initial = c.renderState();
  assert.deepEqual(c.frame(), {x: 450, y: 0, width: 300, height: 600});
  f.controls.move(other().position, other().target, 3);
  assert.deepEqual(f.notices, ['render']);
  assert.equal(c.renderState().height, initial.height);
  f.camera.top *= 2; f.camera.bottom *= 2; f.camera.updateProjectionMatrix(); c.capture();
  close(c.renderState().height, initial.height * 2);
  assert.deepEqual(f.notices, ['render', 'render']);
});

test('landscape contain frame expands working height but not render height', () => {
  const f = fixture(), c = f.controller, initial = c.renderState();
  f.setOutput({width: 1600, height: 400}); f.setViewport({width: 500, height: 1000}); c.resized();
  assert.deepEqual(c.frame(), {x: 0, y: 437.5, width: 500, height: 125});
  close(f.camera.top - f.camera.bottom, initial.height * 8);
  assert.deepEqual(c.renderState(), initial); assert.deepEqual(f.notices, []);
  f.camera.top *= 1.5; f.camera.bottom *= 1.5; c.capture();
  close(c.renderState().height, initial.height * 1.5);
});

test('resize captures edits using OLD dimensions before projecting NEW dimensions', () => {
  const f = fixture(), c = f.controller, initial = c.renderState();
  f.setOutput({width: 1600, height: 400}); f.setViewport({width: 500, height: 1000}); c.resized();
  f.camera.top *= 2; f.camera.bottom *= 2;
  f.setViewport({width: 2000, height: 400}); c.resized();
  close(c.renderState().height, initial.height * 2);
  close(f.camera.top - f.camera.bottom, initial.height * 2);
  assert.deepEqual(c.frame(), {x: 200, y: 0, width: 1600, height: 400});
  assert.deepEqual(f.notices, ['render']);
});

test('navigation projection uses full viewport, resize never rescales its base height', () => {
  const f = fixture(), c = f.controller; c.setMode(false); c.setActive(other()); f.notices.length = 0;
  close(f.camera.top - f.camera.bottom, 8); close((f.camera.right - f.camera.left) / 8, 2);
  f.setViewport({width: 200, height: 1000}); c.resized();
  close(f.camera.top - f.camera.bottom, 8); close((f.camera.right - f.camera.left) / 8, .2);
  assert.deepEqual(c.editorState().viewport, other()); assert.deepEqual(c.renderState(), view()); assert.deepEqual(f.notices, []);
});

test('output camera uses stored render/output aspect and never mutates working camera', () => {
  const f = fixture(), c = f.controller; c.setEditor(editor(false)); const before = cameraSnapshot(f.camera);
  const output = c.outputCamera();
  assert.notEqual(output, f.camera); assert.ok(output.isOrthographicCamera);
  assert.deepEqual(cameraSnapshot(f.camera), before);
  close(output.top - output.bottom, view().height);
  close((output.right - output.left) / (output.top - output.bottom), .5);
  close(output.zoom, view().zoom); view().position.forEach((x, i) => close(output.position.getComponent(i), x));
  f.setOutput({width: 2000, height: 500});
  const second = c.outputCamera(); close((second.right - second.left) / (second.top - second.bottom), 4);
  assert.deepEqual(c.renderState(), view()); assert.deepEqual(cameraSnapshot(f.camera), before); assert.deepEqual(f.notices, []);
});

test('actual Three projection agrees between output edges and viewport frame edges', () => {
  const f = fixture(), c = f.controller;
  for (const [vp, out] of [[{width:1200,height:600},{width:600,height:1200}], [{width:500,height:1000},{width:1600,height:400}]]) {
    f.setViewport(vp); f.setOutput(out); c.resized(); const frame = c.frame(), oc = c.outputCamera();
    oc.updateMatrixWorld(true); f.camera.updateMatrixWorld(true);
    for (const [x,y] of [[-1,-1],[1,1],[-1,1],[1,-1],[0,0]]) {
      const world = new Vector3(x,y,0).unproject(oc), p = world.project(f.camera);
      close((p.x + 1) * vp.width / 2, frame.x + (x + 1) * frame.width / 2);
      close((1 - p.y) * vp.height / 2, frame.y + (1 - y) * frame.height / 2);
    }
  }
});

test('setRender and setEditor restore silently; editor round trip cannot replace render', () => {
  const f = fixture(), c = f.controller; c.setRender(other()); c.setEditor(editor(false, view()));
  assert.deepEqual(c.renderState(), other()); assert.deepEqual(c.editorState(), editor(false, view()));
  const saved = c.editorState(); c.setEditor(editor(true, other())); c.setEditor(saved);
  assert.deepEqual(c.editorState(), saved); assert.deepEqual(c.renderState(), other()); assert.deepEqual(f.notices, []);
  c.setRender(view()); assert.deepEqual(c.editorState(), saved); assert.deepEqual(f.notices, []);
});

test('setActive sets only active view and emits correct kind without no-op noise', () => {
  const f = fixture(), c = f.controller;
  c.setActive(other()); assert.deepEqual(c.renderState(), other()); assert.deepEqual(f.notices, ['render']);
  c.setActive(other()); assert.deepEqual(f.notices, ['render']);
  c.setMode(false); f.notices.length = 0; c.setActive(other());
  assert.deepEqual(c.editorState().viewport, other()); assert.deepEqual(c.renderState(), other()); assert.deepEqual(f.notices, ['editor']);
});

test('every state return and output camera has no mutable aliases', () => {
  const f = fixture(), c = f.controller, original = c.renderState();
  c.renderState().position[0] = 99; c.editorState().viewport.target[1] = 99; c.capture().position[2] = 99;
  const oc = c.outputCamera(); oc.position.x = 99; oc.up.y = 99; oc.projectionMatrix.elements[0] = 99;
  const frame = c.frame(); frame.width = 99;
  assert.deepEqual(c.renderState(), original); assert.deepEqual(c.editorState().viewport, original);
  const input = editor(false, other()); c.setEditor(input); input.viewport.position[0] = 99;
  assert.deepEqual(c.editorState().viewport, other());
});

test('near/far/up stay exact across modes and do not bleed between states', () => {
  const initial = {...view(), near: .123456789, far: 456.789123, up: [0,0,1]}, f = fixture(initial), c = f.controller;
  c.setEditor(editor(false, other())); assert.equal(f.camera.near, .01); assert.equal(f.camera.far, 1000); assert.deepEqual(f.camera.up.toArray(), [0,1,0]);
  c.setMode(true); assert.deepEqual(c.renderState(), initial); assert.equal(f.camera.near, initial.near); assert.equal(f.camera.far, initial.far); assert.deepEqual(f.camera.up.toArray(), initial.up);
  c.resized(); c.outputCamera(); assert.deepEqual(c.renderState(), initial);
});

test('camera operations cannot modify or reference actor pose state', () => {
  const pose = {jaw:[.1,.2,.3],spine:[0,.4,0]}, before = structuredClone(pose), f = fixture();
  f.controller.setMode(false); f.controls.move(other().position,other().target); f.controller.resized(); f.controller.setMode(true); f.controller.outputCamera();
  assert.deepEqual(pose,before); assert.equal('pose' in f.controller.renderState(),false); assert.equal('pose' in f.controller.editorState(),false);
});

test('malformed view/editor descriptors reject atomically', () => {
  const f = fixture(), c = f.controller, initial = c.renderState(), before = cameraSnapshot(f.camera);
  const invalid = [null, [], {}, {...view(),position:[1,2]}, {...view(),target:[1,Infinity,2]}, {...view(),position:[1,'2',3]}, {...view(),zoom:0}, {...view(),zoom:NaN}, {...view(),height:-1}, {...view(),height:Infinity}, {...view(),near:-1}, {...view(),far:.001}, {...view(),up:[0,0,0]}];
  for (const bad of invalid) for (const method of ['setRender','setActive','initialize']) assert.throws(() => c[method](bad), undefined, method);
  for (const bad of [null, {}, editor('false'), {...editor(false),schema:'wrong'}, editor(false, {...other(),height:0})]) assert.throws(() => c.setEditor(bad));
  assert.throws(() => c.setMode(0)); assert.deepEqual(c.renderState(), initial); assert.deepEqual(cameraSnapshot(f.camera), before); assert.deepEqual(f.notices, []);
});

test('sparse finite-vector impostors reject atomically', () => {
  const f = fixture(), before = cameraSnapshot(f.camera);
  const sparse = new Array(3); sparse[0] = 1;
  for (const key of ['position','target','up']) assert.throws(() => f.controller.setRender({...view(), [key]: sparse}), /finite vector/);
  assert.deepEqual(cameraSnapshot(f.camera), before);
  assert.deepEqual(f.controller.renderState(), view());
});

test('direct edits without controls events are captured before switching and cloning', () => {
  const f = fixture(), c = f.controller;
  f.camera.zoom = 4; const output = c.outputCamera(); assert.equal(output.zoom, 4);
  assert.deepEqual(f.notices, ['render']);
  c.setMode(false); f.notices.length = 0;
  f.camera.position.x += 2; f.controls.target.z += 3; f.camera.zoom = 6;
  c.setMode(true);
  assert.equal(c.renderState().zoom, 4); assert.equal(c.editorState().viewport.zoom, 6);
  close(c.editorState().viewport.position[0], view().position[0] + 2);
  close(c.editorState().viewport.target[2], view().target[2] + 3);
  assert.deepEqual(f.notices, ['editor', 'editor']);
});

test('hundreds of output/aspect/mode changes preserve exact state with no render noise', () => {
  const f = fixture(), c = f.controller, original = c.renderState();
  for (let i = 1; i <= 300; i++) {
    f.setViewport({width: 200 + i * 7, height: 100 + (i % 17) * 31});
    f.setOutput({width: 400 + (i % 7) * 300, height: 100 + (i % 11) * 121});
    c.resized(); c.setMode(i % 2 === 0); c.outputCamera(); f.controls.update();
  }
  assert.deepEqual(c.renderState(), original); assert.deepEqual(c.editorState().viewport, original);
  assert.ok(f.notices.every(kind => kind === 'editor'));
});

test('nonpositive/nonfinite viewport and output dimensions reject without mutation', () => {
  for (const kind of ['viewport','output']) for (const bad of [{width:0,height:10},{width:10,height:-1},{width:NaN,height:10},{width:10,height:Infinity}]) {
    const f = fixture(), c = f.controller, before = cameraSnapshot(f.camera);
    (kind === 'viewport' ? f.setViewport : f.setOutput)(bad);
    assert.throws(() => c.resized()); assert.throws(() => c.frame());
    if (kind === 'output') assert.throws(() => c.outputCamera());
    assert.deepEqual(cameraSnapshot(f.camera), before);
  }
});

test('factory validates camera/control parameters', () => {
  const f = fixture(); const args = {camera:f.camera,controls:f.controls,viewport:()=>({width:1,height:1}),output:()=>({width:1,height:1})};
  for (const bad of [{...args,camera:{}},{...args,controls:{}},{...args,viewport:null},{...args,output:null},{...args,changed:3}]) assert.throws(() => createCameraController(bad));
  f.camera.zoom = 0; assert.throws(() => createCameraController(args));
});

test('actual vendored OrbitControls works CPU-only and flushes damped motion on restoration', async () => {
  const OrbitControls = await cpuOrbitControls();
  const camera = new OrthographicCamera(-1,1,1,-1,.01,1000), controls = new OrbitControls(camera, null), notices = [];
  controls.enableDamping = true; controls.autoRotate = false;
  const c = createCameraController({camera, controls, viewport:()=>({width:1200,height:600}), output:()=>({width:800,height:1600}), changed:kind=>notices.push(kind)});
  c.initialize(view());
  for (let i = 0; i < 40; i++) { c.setMode(false); controls.update(); c.setMode(true); controls.update(); }
  assert.deepEqual(c.renderState(), view()); assert.deepEqual(c.editorState().viewport, view());
  assert.ok(notices.every(kind=>kind==='editor'));
  c.setMode(false); notices.length = 0;
  // Seed genuine OrbitControls damping/pan deltas, without DOM/pointer events.
  controls._sphericalDelta.theta = .3; controls._panOffset.set(.2,.3,.4); controls.update();
  assert.deepEqual(c.renderState(), view()); assert.equal(notices.at(-1),'editor');
  c.setMode(true); const restored = cameraSnapshot(camera), render = c.renderState(); notices.length = 0;
  controls.update(); controls.update(); c.capture();
  assert.deepEqual(c.renderState(), render); assert.deepEqual(render, view());
  restored.position.forEach((x,i)=>close(camera.position.getComponent(i),x));
  assert.deepEqual(notices,[]); assert.equal(controls.enableDamping,true); assert.equal(controls.autoRotate,false);
  c.dispose(); // No DOM existed, so intentionally do not call OrbitControls.dispose().
});

test('dispose detaches only owned listener, is idempotent and never disposes controls', () => {
  const f = fixture(), c = f.controller; let external = 0, disposedControls = false;
  f.controls.addEventListener('change', () => external++); f.controls.dispose = () => {disposedControls = true;};
  c.dispose(); c.dispose(); f.controls.move(other().position, other().target);
  assert.equal(external,1); assert.equal(disposedControls,false); assert.deepEqual(f.notices,[]);
  assert.throws(() => c.capture(), /disposed/i);
});
