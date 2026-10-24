import {t, bindText, bindAttr, onLanguageChange} from './i18n.js';
import {MAX_ACTORS, validateActorId, validateActorPlacement} from './web/scene-state.js';

const METHODS = ['getMode', 'getActors', 'getSelected', 'setMode', 'selectActor', 'addActor',
  'duplicateActor', 'removeActor', 'renameActor', 'setVisible', 'setPlacement', 'resetPlacement', 'fit'];
/** Mount inside the existing Scene section. API mutations own notifications;
 * changed is accepted for integration parity but deliberately never called here.
 * sync() rereads the API; dispose() removes only this UI and its listeners.
 */
export function attachSceneUI({container, api, changed} = {}) {
  if (!container?.ownerDocument || container.tagName !== 'SECTION' || container.id !== 'scene-panel' ||
      !api || METHODS.some(name => typeof api[name] !== 'function') ||
      (changed !== undefined && typeof changed !== 'function')) throw new TypeError('Панель сцены требует section#scene-panel и полный API.');
  const doc = container.ownerDocument, listeners = [];
  if (doc.getElementById('scene-mode-single')) throw new TypeError('Панель сцены уже подключена.');
  let disposed = false, listShape = '', errorSource = '', count = 0;
  let optionBindings = [];
  const bindings = [];
  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) bindings.push(bindText(node, text));
    return node;
  }
  function listen(node, event, fn) {
    node.addEventListener(event, fn); listeners.push(() => node.removeEventListener(event, fn));
  }
  function button(id, text, parent) {
    const node = el('button', 'scene-button', text); node.id = id; node.type = 'button'; parent.append(node); return node;
  }
  function field(id, text, type, parent, attributes = {}) {
    const label = el('label', type === 'checkbox' ? 'scene-check' : 'scene-field');
    const node = el(type === 'select' ? 'select' : 'input'); node.id = id;
    if (type !== 'select') node.type = type;
    for (const [key, value] of Object.entries(attributes)) node[key] = value;
    label.append(el('span', '', text), node); parent.append(label); return node;
  }
  const root = el('div', 'scene-controls');
  root.append(el('h2', '', 'Сцена'));
  const modes = el('div', 'scene-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Режим сцены'); root.append(modes);
  const single = button('scene-mode-single', 'Один персонаж', modes);
  const multi = button('scene-mode-multi', 'Общая сцена', modes);
  const list = field('scene-actors', 'Персонаж для редактирования', 'select', root);
  const actions = el('div', 'scene-actions'); root.append(actions);
  const add = button('scene-add', 'Добавить', actions);
  const duplicate = button('scene-duplicate', 'Дублировать', actions);
  const remove = button('scene-remove', 'Удалить', actions);
  const limit = el('p', 'scene-note'); limit.id = 'scene-limit'; root.append(limit);
  const name = field('scene-name', 'Имя', 'text', root, {autocomplete: 'off'});
  // No maxLength: native UTF-16 truncation would reject valid 64-codepoint names.
  const visible = field('scene-visible', 'Показывать в общей сцене', 'checkbox', root);
  root.append(el('p', 'scene-note', 'В одиночном режиме показан выбранный персонаж. Остальные сохранены в списке.'));
  const positionGroup = el('div', 'scene-vector'); positionGroup.setAttribute('role', 'group'); positionGroup.setAttribute('aria-label', 'Положение, дм'); root.append(positionGroup);
  const position = ['x', 'y', 'z'].map(axis => field(`scene-position-${axis}`, `${axis.toUpperCase()}, дм`, 'number', positionGroup, {min: -1000, max: 1000, step: .1}));
  const rotationGroup = el('div', 'scene-vector'); rotationGroup.setAttribute('role', 'group'); rotationGroup.setAttribute('aria-label', 'Поворот, градусы'); root.append(rotationGroup);
  const rotation = ['x', 'y', 'z'].map(axis => field(`scene-rotation-${axis}`, `${axis.toUpperCase()}, °`, 'number', rotationGroup, {min: -180, max: 180, step: 1}));
  const placementActions = el('div', 'scene-placement-actions'); root.append(placementActions);
  const reset = button('scene-reset-placement', 'Сбросить положение', placementActions);
  const fit = button('scene-fit', 'Вписать в кадр', placementActions);
  const error = el('p', 'scene-error'); error.id = 'scene-error'; error.setAttribute('role', 'alert'); error.setAttribute('aria-live', 'polite'); root.append(error);
  bindings.push(bindAttr(modes, 'aria-label', 'Режим сцены'),
    bindAttr(positionGroup, 'aria-label', 'Положение, дм'),
    bindAttr(rotationGroup, 'aria-label', 'Поворот, градусы'));
  function refreshMessages() {
    if (disposed) return;
    error.textContent = t(errorSource);
    limit.textContent = t('Персонажей: {count} / {max}. Не более 4 в сцене.', {count, max: MAX_ACTORS});
  }
  function report(problem) { if (!disposed) { errorSource = problem?.message || String(problem); refreshMessages(); } }
  function snapshot() {
    const mode = api.getMode(), actors = api.getActors(), selected = api.getSelected();
    if (!['single', 'multi'].includes(mode) || !Array.isArray(actors) || actors.length < 1 || actors.length > MAX_ACTORS) throw new TypeError('Некорректный список персонажей или режим сцены.');
    const ids = new Set();
    for (const actor of actors) {
      validateActorId(actor.id);
      if (ids.has(actor.id) || typeof actor.name !== 'string' || typeof actor.visible !== 'boolean') throw new TypeError('Некорректная запись персонажа.');
      ids.add(actor.id); validateActorPlacement(actor.position); validateActorPlacement(actor.rotation, true);
    }
    const actor = actors.find(item => item.id === selected);
    if (!actor) throw new TypeError('Выбранный персонаж отсутствует в сцене.');
    return {mode, actors, selected, actor};
  }
  function sync() {
    if (disposed) return;
    const {mode, actors, selected, actor} = snapshot();
    for (const [node, value] of [[single, 'single'], [multi, 'multi']]) {
      node.setAttribute('aria-pressed', String(mode === value)); node.classList.toggle('selected', mode === value);
    }
    const shape = JSON.stringify(actors.map(item => [item.id, item.name, item.visible]));
    if (shape !== listShape) {
      listShape = shape; for (const unbind of optionBindings) unbind(); optionBindings = []; list.replaceChildren();
      for (const item of actors) {
        const option = el('option');
        optionBindings.push(bindText(option, '{name}{hidden}', () => ({name: item.name, hidden: item.visible ? '' : t(' · скрыт')})));
        option.value = item.id; list.append(option);
      }
    }
    list.value = selected; name.value = actor.name; visible.checked = actor.visible;
    position.forEach((node, i) => { node.value = String(actor.position[i]); });
    rotation.forEach((node, i) => { node.value = String(actor.rotation[i] * 180 / Math.PI); });
    add.disabled = duplicate.disabled = actors.length >= MAX_ACTORS;
    remove.disabled = actors.length <= 1;
    count = actors.length; refreshMessages();
  }
  function run(fn) {
    if (disposed) return;
    try {
      const result = fn();
      const finish = () => { if (!disposed) { sync(); errorSource = ''; refreshMessages(); } };
      if (result && typeof result.then === 'function') result.then(finish).catch(report);
      else finish();
    } catch (problem) { report(problem); }
  }
  function activation(node, fn) { listen(node, 'click', () => { if (!node.disabled) run(fn); }); }
  activation(single, () => api.setMode('single'));
  activation(multi, () => api.setMode('multi'));
  listen(list, 'change', () => run(() => {
    const id = validateActorId(list.value);
    if (!api.getActors().some(actor => actor.id === id)) throw new Error('Персонаж отсутствует в списке.');
    return api.selectActor(id);
  }));
  for (const [node, method] of [[add, 'addActor'], [duplicate, 'duplicateActor'], [remove, 'removeActor']]) activation(node, () => {
    const {actors} = snapshot();
    if (method === 'removeActor' ? actors.length <= 1 : actors.length >= MAX_ACTORS) throw new Error(method === 'removeActor' ? 'Нельзя удалить последнего персонажа.' : 'В сцене не более 4 персонажей.');
    return api[method]();
  });
  listen(name, 'change', () => run(() => {
    const next = name.value.trim();
    if (!next || [...next].length > 64 || /[\u0000-\u001f\u007f]/.test(name.value)) throw new Error('Имя: от 1 до 64 символов без управляющих символов.');
    return api.renameActor(next);
  }));
  listen(visible, 'change', () => run(() => api.setVisible(visible.checked)));
  function readVector(nodes, isRotation) {
    const values = nodes.map(node => {
      if (!node.value.trim()) throw new Error('Укажите все три числовых значения.');
      const value = Number(node.value);
      if (!Number.isFinite(value) || (isRotation && Math.abs(value) > 180)) throw new Error(isRotation ? 'Поворот: от −180 до 180 градусов.' : 'Положение: конечное число от −1000 до 1000 дм.');
      return isRotation ? value * Math.PI / 180 : value;
    });
    return validateActorPlacement(values, isRotation);
  }
  for (const node of [...position, ...rotation]) listen(node, 'change', () => run(() => {
    // Validate every field before the API sees anything; invalid drafts never mutate.
    const next = {position: readVector(position, false), rotation: readVector(rotation, true)};
    return api.setPlacement(next);
  }));
  activation(reset, () => api.resetPlacement()); activation(fit, () => api.fit());
  // Validate API data before attaching any nodes to the supplied section.
  try { sync(); } catch (problem) { for (const unbind of [...bindings, ...optionBindings]) unbind(); throw problem; }
  bindings.push(onLanguageChange(refreshMessages)); container.append(root);
  return {
    sync,
    dispose() {
      if (disposed) return;
      disposed = true; for (const unbind of [...bindings, ...optionBindings]) unbind(); for (const removeListener of listeners) removeListener(); root.remove();
    },
  };
}
