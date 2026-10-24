import {clampMorph,morphRange} from './identity-morphs.js';
import {t,bindText,bindAttr,localizeDOM,messages} from './i18n.js';
const groups={head:'Голова, лоб и щёки',eyes:'Глаза',nose:'Нос',mouth:'Рот и губы',jaw:'Подбородок и челюсть',ears:'Уши',torso:'Пропорции корпуса',chest:'Грудь',arms:'Руки',legs:'Ноги'};
const legacy={nose_width:['Ширина носа','nose'],chin_width:['Ширина подбородка','jaw'],mouth_width:['Ширина рта','mouth'],head_square:['Квадратная форма головы','head'],muscle:['Мускулатура','torso'],weight:['Масса тела','torso']};
const faceGroups=new Set(['head','eyes','nose','mouth','jaw','ears']);
const normalized=s=>s.toLocaleLowerCase('ru').replaceAll('ё','е');
export function attachIdentityUI({container,morphs,state,change}) {
 const meta=morphs.map(m=>({m,label:m.labelRu||legacy[m.id]?.[0]||m.label||m.id,group:m.group||legacy[m.id]?.[1]||'torso'}));
 const root=document.createElement('div');root.className='identity-editor';
 root.innerHTML='<div class="identity-search"><input id="shape-search" type="search" data-i18n-placeholder="Найти параметр…" data-i18n-aria-label="Поиск параметров внешности" autocomplete="off"></div><div class="seg identity-tabs"><button type="button" data-shape-area="all" class="active" data-i18n="Всё"></button><button type="button" data-shape-area="face" data-i18n="Лицо"></button><button type="button" data-shape-area="body" data-i18n="Тело"></button></div><div class="identity-overview"><span id="shape-count"></span><button id="shape-reset" type="button" data-i18n="Сбросить форму"></button></div><p id="shape-empty" class="note" hidden data-i18n="Параметры не найдены."></p><div id="shape-groups"></div>';
 container.replaceChildren(root);
 const search=root.querySelector('#shape-search'),groupRoot=root.querySelector('#shape-groups'),rows=[],sections=[];
 let area='all',visibleCount=0,disposed=false;
 const bindings=[localizeDOM(root)],listeners=[];
 const text=(node,source,params={})=>bindings.push(bindText(node,source,params));
 const attr=(node,key,source,params={})=>bindings.push(bindAttr(node,key,source,params));
 text(root.querySelector('#shape-count'),'{visible} / {count} параметров',()=>({visible:visibleCount,count:meta.length}));
 for(const [key,label]of Object.entries(groups)){
  const entries=meta.filter(m=>m.group===key);if(!entries.length)continue;
  const details=document.createElement('details');details.className='identity-group';details.dataset.shapeGroup=key;details.open=key==='head'||key==='eyes';
  const summary=document.createElement('summary'),name=document.createElement('span'),count=document.createElement('span');text(name,label);count.className='identity-group-count';summary.append(name,count);details.append(summary);
  const body=document.createElement('div');body.className='identity-group-body';
  const reset=document.createElement('button');reset.type='button';reset.className='identity-reset-group';text(reset,'Сбросить раздел');reset.dataset.shapeReset=key;reset.onclick=()=>{for(const {m}of entries)state.morphs[m.id]=0;change();sync();};body.append(reset);
  for(const info of entries){
   const {m,label}=info,row=document.createElement('div');row.className='identity-slider';row.dataset.shapeRow=m.id;
   const header=document.createElement('div');header.className='identity-slider-title';const caption=document.createElement('label');caption.htmlFor='shape-'+m.id;text(caption,label);
   const number=document.createElement('input');number.type='number';number.step='.01';number.dataset.morphValue=m.id;attr(number,'aria-label','{label} · точное значение',()=>({label:t(label)}));
   const resetOne=document.createElement('button');resetOne.type='button';resetOne.className='identity-reset-one';resetOne.textContent='↺';attr(resetOne,'title','Вернуть исходное значение');attr(resetOne,'aria-label','{label} · сброс',()=>({label:t(label)}));resetOne.dataset.shapeReset=m.id;
   header.append(caption,number,resetOne);
   const range=document.createElement('input');range.type='range';range.id=caption.htmlFor;range.dataset.morph=m.id;range.step='.01';attr(range,'aria-label',label);
   const endpoints=document.createElement('div');endpoints.className='identity-endpoints';const negative=document.createElement('span'),positive=document.createElement('span');text(negative,m.negativeLabelRu||((m.min??0)<0?'−1':'Исходная'));text(positive,m.positiveLabelRu||'+1');endpoints.append(negative,positive);
   function update(value){state.morphs[m.id]=clampMorph(m,value,state.free);change();sync();}
   range.oninput=()=>update(Number(range.value));number.onchange=()=>update(Number(number.value));number.onkeydown=e=>{if(e.key==='Enter')number.blur();};resetOne.onclick=()=>update(0);
   row.append(header,range,endpoints);body.append(row);rows.push({info,row,range,number,resetOne});
  }
  details.append(body);groupRoot.append(details);sections.push({key,details,count,entries,defaultOpen:details.open});
 }
 function filter(){if(disposed)return;const q=normalized(search.value.trim());let visible=0;for(const {info,row}of rows){const group=groups[info.group]||'',terms=[info.label,messages[info.label],info.m.label,info.m.id,group,messages[group],info.m.negativeLabelRu,info.m.positiveLabelRu];const matches=(!q||normalized(terms.filter(Boolean).join(' ')).includes(q))&&(area==='all'||faceGroups.has(info.group)===(area==='face'));row.hidden=!matches;if(matches)visible++;}
  for(const section of sections){const n=section.entries.filter(info=>!root.querySelector(`[data-shape-row="${info.m.id}"]`).hidden).length;section.details.hidden=!n;if(q)section.details.open=true;else section.details.open=section.defaultOpen;}
  visibleCount=visible;root.querySelector('#shape-empty').hidden=visible>0;root.querySelector('#shape-count').textContent=t('{visible} / {count} параметров',{visible,count:meta.length});
 }
 search.oninput=filter;
 root.querySelectorAll('[data-shape-area]').forEach(button=>button.onclick=()=>{area=button.dataset.shapeArea;root.querySelectorAll('[data-shape-area]').forEach(b=>b.classList.toggle('active',b===button));filter();});
 for(const section of sections){const toggle=()=>{if(!search.value.trim())section.defaultOpen=section.details.open;};section.details.addEventListener('toggle',toggle);listeners.push(()=>section.details.removeEventListener('toggle',toggle));}
 root.querySelector('#shape-reset').onclick=()=>{for(const {m}of meta)state.morphs[m.id]=0;change();sync();};
 function sync(){if(disposed)return;for(const {info,row,range,number,resetOne}of rows){const [min,max]=morphRange(info.m,state.free),value=state.morphs[info.m.id]||0;range.min=number.min=min;range.max=number.max=max;range.value=value;if(document.activeElement!==number)number.value=value.toFixed(2);row.classList.toggle('modified',Math.abs(value)>1e-8);resetOne.disabled=Math.abs(value)<1e-8;}
  for(const section of sections){const n=section.entries.filter(({m})=>Math.abs(state.morphs[m.id]||0)>1e-8).length;section.count.textContent=n?`${n} / ${section.entries.length}`:String(section.entries.length);}
 }
 function focusGroup(group){if(disposed)return;search.value='';area='all';root.querySelectorAll('[data-shape-area]').forEach(b=>b.classList.toggle('active',b.dataset.shapeArea==='all'));filter();const target=sections.find(s=>s.key===group);if(target){target.details.open=true;target.details.scrollIntoView({block:'nearest'});target.details.querySelector('summary').focus();}}
 filter();sync();return {sync,focusGroup,count:meta.length,groups:sections.map(s=>s.key),dispose(){if(disposed)return;disposed=true;bindings.forEach(off=>off());listeners.forEach(off=>off());for(const node of [root,...root.querySelectorAll('*')])for(const key of ['onclick','oninput','onchange','onkeydown'])node[key]=null;root.remove();}};
}
