import {defaults, normalizeState} from './web/state.js';
import {SCENE_SCHEMA, MAX_ACTORS, characterState, validateActorId, validateActorPlacement} from './web/scene-state.js';

const clone = value => structuredClone(value);
const GLOBAL_KEYS = ['view', 'alpha', 'camera', 'canvas', 'sheet'];
/** Late-bound facade for tools retaining a rig/body reference. Methods bind to
 * the current object, never the Proxy (Three objects have private ownership). */
export function activeProxy(resolve) {
  return new Proxy({}, {
    get(_target, key) { const source = resolve(), value = source?.[key]; return typeof value === 'function' ? value.bind(source) : value; },
    set(_target, key, value) { const source = resolve(); if (!source) throw Error('Модель ещё не загружена'); source[key] = value; return true; },
    ownKeys() { return Reflect.ownKeys(resolve() || {}); },
    getOwnPropertyDescriptor(_target, key) { const source = resolve(); return source && Object.hasOwn(source, key) ? {configurable:true, enumerable:true, writable:true, value:source[key]} : undefined; },
    has(_target, key) { return key in (resolve() || {}); },
  });
}

/** Actor-list ownership without DOM or Three dependencies. Allocate a complete
 * replacement before committing; failures dispose only the candidate runtimes.
 * Runtime state is authoritative: factories clone inputs and bind that stable
 * state object to their own rig, not to the selected-editor facade. */
export function createSceneController({initialState = defaults(), createActor, changed = () => {}, selected = () => {}, fit = () => {}}) {
  if (typeof createActor !== 'function') throw TypeError('createActor is required');
  let records = [], runtimes = new Map(), selectedId, soloActor, mode = 'single', sceneDocument = false, disposed = false, serial = 0;
  const shared = {};
  function live() { if (disposed) throw Error('Сцена закрыта'); }
  function current(id = selectedId) { live(); validateActorId(id); const value = records.find(a => a.id === id); if (!value) throw Error('Персонаж отсутствует в сцене'); return value; }
  function runtime(id = selectedId) { current(id); return runtimes.get(id); }
  function visibility() { for (const record of records) { const actor = runtimes.get(record.id); actor.setVisible(record.visible && (mode !== 'single' || record.id === soloActor)); actor.setActive(record.id === selectedId); } }
  function notify(kind = 'render', selection = false) { visibility(); if (selection) selected(runtime()); changed(kind); }
  function nextId() { let id; do { id = `actor-${++serial}`; } while (runtimes.has(id)); return id; }
  function recordFor(id, state, name = 'Персонаж', position = [0,0,0]) { return {id,name,visible:true,position,rotation:[0,0,0],state:characterState(state)}; }
  function allocate(record) { let actor; try { actor = createActor(clone(record)); actor.setActive(false); actor.setPlacement({position:record.position,rotation:record.rotation}); return actor; } catch (error) { actor?.dispose(); throw error; } }
  function serialize(camera) {
    live(); const globals = clone(shared); if (camera !== undefined) globals.camera = clone(camera);
    if (!sceneDocument) return normalizeState({...clone(runtime().state), ...globals, schema:'character-3d-preview/1'});
    return normalizeState({schema:SCENE_SCHEMA,mode,soloActor,actors:records.map(record => ({...clone(record),state:characterState(runtime(record.id).state)})),...globals});
  }
  function replace(input, editorSelected) {
    live(); const validated = normalizeState(input), isScene = validated.schema === SCENE_SCHEMA;
    const nextRecords = isScene ? validated.actors : [recordFor('actor-1', validated)];
    if (editorSelected !== undefined && !nextRecords.some(a => a.id === editorSelected)) throw Error('Выбранный персонаж отсутствует в сцене');
    const nextRuntimes = new Map();
    try { for (const record of nextRecords) nextRuntimes.set(record.id, allocate(record)); }
    catch (error) { for (const actor of nextRuntimes.values()) actor.dispose(); throw error; }
    const old = runtimes; records = nextRecords; runtimes = nextRuntimes; sceneDocument = isScene; mode = isScene ? validated.mode : 'single';
    soloActor = isScene ? validated.soloActor : nextRecords[0].id; selectedId = editorSelected || soloActor;
    for (const key of Object.keys(shared)) delete shared[key];
    for (const key of GLOBAL_KEYS) if (Object.hasOwn(validated,key)) shared[key] = clone(validated[key]);
    for (const actor of old.values()) actor.dispose(); notify('render',true);
  }
  const state = new Proxy({}, {
    get(_target,key) { return key === 'schema' ? 'character-3d-preview/1' : GLOBAL_KEYS.includes(key) ? shared[key] : runtime().state[key]; },
    set(_target,key,value) { if (key === 'schema') throw Error('Use replace to change schema'); (GLOBAL_KEYS.includes(key) ? shared : runtime().state)[key] = value; return true; },
    deleteProperty(_target,key) { delete (GLOBAL_KEYS.includes(key) ? shared : runtime().state)[key]; return true; },
    ownKeys() { return [...new Set([...Object.keys(runtime().state).filter(key => !GLOBAL_KEYS.includes(key)),...Object.keys(shared)])]; },
    getOwnPropertyDescriptor(_target,key) { if (key === 'schema' || Object.hasOwn(GLOBAL_KEYS.includes(key) ? shared : runtime().state,key)) return {enumerable:true,configurable:true,writable:true,value:state[key]}; },
    has(_target,key) { return key === 'schema' || Object.hasOwn(GLOBAL_KEYS.includes(key) ? shared : runtime().state,key); },
  });
  const api = {
    state, shared, serialize, replace, runtime, isScene:() => sceneDocument,
    getMode:() => mode, getSelected:() => selectedId,
    getActors:() => { live(); return records.map(({state:_state,...metadata}) => clone(metadata)); },
    visibleActors:() => { live(); return records.filter(a => a.visible && (mode !== 'single' || a.id === soloActor)).map(a => runtimes.get(a.id)); },
    allActors:() => { live(); return [...runtimes.values()]; },
    setMode(value) { live(); if (!['single','multi'].includes(value)) throw Error('Неизвестный режим сцены'); if (value === mode) return; mode = value; soloActor = selectedId; if (value === 'multi' && !sceneDocument) shared.view = 'body'; sceneDocument = true; notify(); },
    selectActor(id) { current(id); if (id === selectedId) return; selectedId = id; if (mode === 'single') soloActor = id; notify(mode === 'multi' ? 'editor' : 'render',true); },
    addActor() { return add(false); }, duplicateActor() { return add(true); },
    removeActor(id = selectedId) { current(id); if (records.length === 1) throw Error('Нельзя удалить последнего персонажа'); const actor = runtime(id); records = records.filter(a => a.id !== id); runtimes.delete(id); if (selectedId === id) selectedId = records[0].id; if (soloActor === id) soloActor = selectedId; sceneDocument = true; actor.dispose(); notify('render',true); },
    renameActor(name,id = selectedId) { const record = current(id); if (typeof name !== 'string' || name !== name.trim() || !name || [...name].length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw Error('Некорректное имя персонажа'); record.name = name; sceneDocument = true; notify(); },
    setVisible(value,id = selectedId) { const record = current(id); if (typeof value !== 'boolean') throw Error('Видимость должна быть boolean'); record.visible = value; sceneDocument = true; notify(); },
    setPlacement(value,id = selectedId) { const record = current(id), position = validateActorPlacement(value.position ?? record.position), rotation = validateActorPlacement(value.rotation ?? record.rotation,true); runtime(id).setPlacement({position,rotation}); record.position = position; record.rotation = rotation; sceneDocument = true; notify(); },
    resetPlacement(id = selectedId) { api.setPlacement({position:[0,0,0],rotation:[0,0,0]},id); },
    fit() { live(); fit(); },
    dispose() { if (disposed) return; disposed = true; for (const actor of runtimes.values()) actor.dispose(); runtimes.clear(); records = []; },
  };
  function add(duplicate) {
    live(); if (records.length >= MAX_ACTORS) throw Error('В сцене не более 4 персонажей');
    const source = current(), position = clone(source.position); position[0] = Math.max(-1000,Math.min(1000,position[0]+6));
    let record = recordFor(nextId(),duplicate ? runtime().state : defaults(),`Персонаж ${serial}`,position);
    if (duplicate) { const suffix = ' · копия'; record.rotation = clone(source.rotation); record.name = [...source.name].slice(0,64-[...suffix].length).join('')+suffix; }
    // Validate the complete prospective scene before allocating or committing.
    record = normalizeState({schema:SCENE_SCHEMA,mode:'multi',soloActor:record.id,actors:[...records.map(a => ({...a,state:characterState(runtime(a.id).state)})),record],...shared,view:sceneDocument ? shared.view : 'body'}).actors.at(-1);
    const actor = allocate(record); records.push(record); runtimes.set(record.id,actor); selectedId = record.id; soloActor = record.id;
    if (!sceneDocument) shared.view = 'body'; sceneDocument = true; mode = 'multi'; notify('render',true); return record.id;
  }
  replace(initialState); return api;
}
