// Browser ESM, dependency-free: the caller owns the existing orthographic camera
// and controls. Never replace that camera (rig/face/identity tools retain it).
const EDITOR_SCHEMA = 'character-3d-editor/1';
const VIEW_KEYS = ['position', 'target', 'zoom', 'height', 'near', 'far', 'up'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const finite = value => typeof value === 'number' && Number.isFinite(value);
function positive(value, name) {
  if (!finite(value) || value <= 0) throw new TypeError(`${name} must be finite and positive`);
  return value;
}
function vector(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || ![0, 1, 2].every(i => own(value, i) && finite(value[i]))) throw new TypeError(`${name} must be a finite vector[3]`);
  return value.slice();
}
function copyView(value) {
  const result = {};
  for (const key of VIEW_KEYS) if (own(value, key)) result[key] = Array.isArray(value[key]) ? value[key].slice() : value[key];
  return result;
}
function validateView(value, defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid view descriptor');
  const result = {position: vector(value.position, 'position'), target: vector(value.target, 'target'), zoom: positive(value.zoom, 'zoom'), height: positive(value.height, 'height')};
  for (const key of ['near', 'far']) if (own(value, key)) {
    if (!finite(value[key])) throw new TypeError(`${key} must be finite`);
    result[key] = value[key];
  }
  const near = result.near ?? defaults.near, far = result.far ?? defaults.far;
  if (near < 0 || far <= near) throw new TypeError('Camera requires 0 <= near < far');
  if (own(value, 'up')) {
    result.up = vector(value.up, 'up');
    if (result.up.every(x => x === 0)) throw new TypeError('up must not be zero');
  }
  if (result.position.every((x, i) => x === result.target[i])) throw new TypeError('Camera position must differ from target');
  return result;
}
// Ignore numerical spherical/quaternion round-trip noise, not real user motion.
const sameNumber = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const sameVector = (a, b) => a.every((x, i) => sameNumber(x, b[i]));
function sameView(a, b) {
  return VIEW_KEYS.every(key => own(a, key) === own(b, key) && (!own(a, key) || (Array.isArray(a[key]) ? a[key].every((x, i) => x === b[key][i]) : a[key] === b[key])));
}
function dimensions(getter, name) {
  const value = getter();
  if (!value || typeof value !== 'object') throw new TypeError(`Invalid ${name} dimensions`);
  return {width: positive(value.width, `${name}.width`), height: positive(value.height, `${name}.height`)};
}
function geometry(viewport, output, cameraMode) {
  const aspect = output.width / output.height;
  positive(aspect, 'output aspect');
  const viewportAspect = viewport.width / viewport.height;
  positive(viewportAspect, 'viewport aspect');
  let width = viewport.width, height = viewport.height;
  if (viewportAspect > aspect) width = height * aspect;
  else height = width / aspect;
  positive(width, 'frame width'); positive(height, 'frame height');
  const scale = cameraMode ? viewport.height / height : 1;
  positive(scale, 'frame scale');
  return {frame: {x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height}, aspect: viewportAspect, scale};
}

/**
 * createCameraController({camera, controls, viewport, output, changed})
 * viewport/output: () => ({width, height}), changed: ('render'|'editor') => void.
 * View: {position:[x,y,z], target:[x,y,z], zoom, height, near?, far?, up?}.
 * Editor: {schema:'character-3d-editor/1', cameraMode:boolean, viewport:View}.
 * height is the unzoomed OUTPUT frustum height in render state, and the full
 * VIEWPORT frustum height in navigation state. frame() uses top-left CSS pixels.
 *
 * initialize/setRender/setEditor are silent restoration operations. setActive
 * emits the active kind on an actual descriptor change. capture() returns a
 * detached active view, and getters capture outstanding real edits as well.
 * resized() must be called when viewport OR output dimensions change. It captures
 * using the previous projection scale before applying the new projection.
 * Output cameras are fresh caller-owned clones; dispose detaches our listener
 * only. Methods other than dispose reject use after disposal.
 */
export function createCameraController({camera, controls, viewport, output, changed = () => {}} = {}) {
  if (!camera?.isOrthographicCamera || typeof camera.clone !== 'function' || typeof camera.updateProjectionMatrix !== 'function' || typeof camera.lookAt !== 'function') throw new TypeError('An existing OrthographicCamera is required');
  if (!controls?.target || typeof controls.target.toArray !== 'function' || typeof controls.target.fromArray !== 'function' || typeof controls.update !== 'function' || typeof controls.addEventListener !== 'function' || typeof controls.removeEventListener !== 'function') throw new TypeError('OrbitControls-like controls are required');
  if (typeof viewport !== 'function' || typeof output !== 'function' || typeof changed !== 'function') throw new TypeError('viewport/output/changed must be functions');
  const defaults = {near: camera.near, far: camera.far, up: vector(camera.up.toArray(), 'camera.up')};
  if (!finite(defaults.near) || defaults.near < 0 || !finite(defaults.far) || defaults.far <= defaults.near || defaults.up.every(x => x === 0)) throw new TypeError('Invalid camera near/far/up');
  positive(camera.zoom, 'camera.zoom'); positive(camera.top - camera.bottom, 'camera.height');
  if (![camera.left, camera.right, camera.top, camera.bottom].every(finite) || camera.right <= camera.left) throw new TypeError('Invalid camera frustum');
  vector(camera.position.toArray(), 'camera.position'); vector(controls.target.toArray(), 'controls.target');

  let renderView, navigationView, cameraMode = true, projection, baseline;
  let restoring = 0, disposed = false;
  function alive(requireInitialized = true) {
    if (disposed) throw new Error('Camera controller is disposed');
    if (requireInitialized && !renderView) throw new Error('Camera controller is not initialized');
  }
  function readGeometry(mode = cameraMode) {
    return geometry(dimensions(viewport, 'viewport'), dimensions(output, 'output'), mode);
  }
  function active() { return cameraMode ? renderView : navigationView; }
  function sample() {
    return {position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), zoom: camera.zoom, height: camera.top - camera.bottom, near: camera.near, far: camera.far};
  }
  function configure(cam, view, aspect, scale, target) {
    const height = positive(view.height * scale, 'projected height');
    const halfWidth = positive(height * aspect / 2, 'projected half width');
    cam.position.fromArray(view.position); target.fromArray(view.target);
    cam.up.fromArray(view.up ?? defaults.up); cam.near = view.near ?? defaults.near; cam.far = view.far ?? defaults.far; cam.zoom = view.zoom;
    cam.top = height / 2; cam.bottom = -height / 2; cam.left = -halfWidth; cam.right = halfWidth;
    cam.lookAt(target); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  }
  function project(view, nextProjection) {
    restoring++;
    try {
      configure(camera, view, nextProjection.aspect, nextProjection.scale, controls.target);
      // Prevent autoRotate/pending damped deltas from changing a restored view.
      const damping = controls.enableDamping, rotate = controls.autoRotate;
      const hadDamping = own(controls, 'enableDamping'), hadRotate = own(controls, 'autoRotate');
      try {
        controls.enableDamping = false; controls.autoRotate = false;
        controls.update();
      } finally {
        if (hadDamping) controls.enableDamping = damping; else delete controls.enableDamping;
        if (hadRotate) controls.autoRotate = rotate; else delete controls.autoRotate;
      }
      // Controls may clamp or introduce tiny FP differences. The saved descriptor
      // remains authoritative; also keep the actual working projection exact.
      configure(camera, view, nextProjection.aspect, nextProjection.scale, controls.target);
      projection = nextProjection; baseline = sample();
    } finally { restoring--; }
  }
  function captureInternal(notify = true) {
    if (restoring) return false;
    const current = sample(), next = copyView(active());
    let edited = false;
    for (const key of ['position', 'target', 'up']) if (!sameVector(current[key], baseline[key])) { next[key] = current[key].slice(); edited = true; }
    for (const key of ['zoom', 'near', 'far']) if (!sameNumber(current[key], baseline[key])) { next[key] = current[key]; edited = true; }
    if (!sameNumber(current.height, baseline.height)) {
      // projection belongs to the PREVIOUS dimensions, never re-read callbacks.
      next.height = current.height / projection.scale; edited = true;
    }
    if (!edited) return false;
    const validated = validateView(next, defaults);
    if (cameraMode) renderView = validated; else navigationView = validated;
    baseline = current;
    if (notify) changed(cameraMode ? 'render' : 'editor');
    return true;
  }
  function onControlsChange() {
    if (!disposed && renderView && !restoring) captureInternal();
  }
  controls.addEventListener('change', onControlsChange);

  return {
    initialize(viewDescriptor) {
      alive(false);
      const view = validateView(viewDescriptor, defaults), nextProjection = readGeometry(true);
      // Validate projection arithmetic before any state or camera mutation.
      positive(view.height * nextProjection.scale, 'projected height');
      positive(view.height * nextProjection.scale * nextProjection.aspect / 2, 'projected half width');
      renderView = copyView(view); navigationView = copyView(view); cameraMode = true;
      project(view, nextProjection);
    },
    mode() { alive(); return cameraMode; },
    setMode(value) {
      alive();
      if (typeof value !== 'boolean') throw new TypeError('cameraMode must be boolean');
      const nextProjection = readGeometry(value);
      captureInternal();
      if (value === cameraMode) return;
      const view = value ? renderView : navigationView;
      positive(view.height * nextProjection.scale * nextProjection.aspect / 2, 'projected half width');
      cameraMode = value; project(view, nextProjection); changed('editor');
    },
    renderState() { alive(); captureInternal(); return copyView(renderView); },
    editorState() { alive(); captureInternal(); return {schema: EDITOR_SCHEMA, cameraMode, viewport: copyView(navigationView)}; },
    setRender(viewDescriptor) {
      alive();
      const view = validateView(viewDescriptor, defaults);
      const nextProjection = cameraMode ? readGeometry() : null;
      if (nextProjection) positive(view.height * nextProjection.scale * nextProjection.aspect / 2, 'projected half width');
      renderView = view;
      if (cameraMode) project(view, nextProjection);
    },
    setEditor(editorDescriptor) {
      alive();
      if (!editorDescriptor || editorDescriptor.schema !== EDITOR_SCHEMA || typeof editorDescriptor.cameraMode !== 'boolean') throw new TypeError('Invalid character-3d editor descriptor');
      const view = validateView(editorDescriptor.viewport, defaults), mode = editorDescriptor.cameraMode;
      const nextProjection = readGeometry(mode), projectedView = mode ? renderView : view;
      positive(projectedView.height * nextProjection.scale * nextProjection.aspect / 2, 'projected half width');
      navigationView = view; cameraMode = mode; project(projectedView, nextProjection);
    },
    setActive(viewDescriptor) {
      alive();
      const view = validateView(viewDescriptor, defaults), nextProjection = readGeometry();
      positive(view.height * nextProjection.scale * nextProjection.aspect / 2, 'projected half width');
      const edited = !sameView(active(), view);
      if (cameraMode) renderView = view; else navigationView = view;
      project(view, nextProjection);
      if (edited) changed(cameraMode ? 'render' : 'editor');
    },
    resized() {
      alive();
      const nextProjection = readGeometry();
      captureInternal();
      positive(active().height * nextProjection.scale * nextProjection.aspect / 2, 'projected half width');
      project(active(), nextProjection);
    },
    capture() { alive(); captureInternal(); return copyView(active()); },
    outputCamera() {
      alive();
      const size = dimensions(output, 'output'), aspect = positive(size.width / size.height, 'output aspect');
      captureInternal();
      const clone = camera.clone(), target = controls.target.clone();
      configure(clone, renderView, aspect, 1, target);
      return clone;
    },
    frame() { alive(); return {...readGeometry().frame}; },
    dispose() {
      if (disposed) return;
      disposed = true; controls.removeEventListener('change', onControlsChange);
    }
  };
}
