import {t, bindText} from './i18n.js';
// Editor-only display/picking UI; never modifies frozen render state.
export function attachRigUI({section,rig,changed}){
 const box=document.createElement('div');box.className='rig-display';
 box.innerHTML='<h3 data-i18n="Слои рига"></h3><label class="row"><span data-i18n="Выбор суставов кликом"></span> <input id="pick-joints" type="checkbox" checked></label><div class="rig-layer-grid"><label><input id="show-rig" data-rig-layer="bones" type="checkbox"> <span data-i18n="Кости"></span></label><label><input data-rig-layer="joints" type="checkbox"> <span data-i18n="Суставы"></span></label><label><input data-rig-layer="controllers" type="checkbox"> <span data-i18n="Вращатель"></span></label></div><div class="rig-layer-grid categories"><label><input data-rig-layer="body" type="checkbox"> <span data-i18n="Тело"></span></label><label><input data-rig-layer="hands" type="checkbox"> <span data-i18n="Кисти"></span></label><label><input data-rig-layer="face" type="checkbox"> <span data-i18n="Лицо"></span></label></div><label class="row"><span data-i18n="Риг сквозь модель"></span> <input data-rig-layer="xray" type="checkbox"></label><p id="joint-hover-label" class="note"></p>';
 section.querySelector('h2').after(box);let picking=true,disposed=false,hoverId='';
 let hoverSource='Наведи на модель и выбери ближайший сустав. Повторный или Alt-клик переключает перекрывающиеся суставы. Пустое место не выбирает дальнюю кость.';
 const bindings=[...box.querySelectorAll('[data-i18n]')].map(node=>bindText(node,node.dataset.i18n));
 const note=box.querySelector('#joint-hover-label'),pick=box.querySelector('#pick-joints');
 bindings.push(bindText(note,()=>hoverSource,()=>({id:hoverId})));
 const nodes=[...box.querySelectorAll('[data-rig-layer]')];
 function sync(){if(disposed)return;const s=rig.getLayers();nodes.forEach(e=>e.checked=s[e.dataset.rigLayer]);pick.checked=picking;}
 nodes.forEach(e=>{if(!e.id)e.id='rig-'+e.dataset.rigLayer;e.onchange=()=>{if(disposed)return;rig.setLayers({...rig.getLayers(),[e.dataset.rigLayer]:e.checked});sync();changed();};});pick.onchange=e=>{if(disposed)return;picking=e.target.checked;changed();};sync();
 return {sync,enabled:()=>picking,metadata:()=>({jointPicking:picking}),restore:s=>{if(disposed)return;picking=typeof s?.jointPicking==='boolean'?s.jointPicking:true;sync();},hover:j=>{
  if(disposed)return;hoverId=j?.id??'';hoverSource=j?'Рядом: {id} · клик для выбора':'Наведи на модель и выбери ближайший сустав. Повторный или Alt-клик переключает совпадающие позиции.';
  note.textContent=t(hoverSource,{id:hoverId});
 },dispose(){if(disposed)return;disposed=true;for(const unbind of bindings)unbind();for(const node of [...nodes,pick])node.onchange=null;box.remove();}};
}
