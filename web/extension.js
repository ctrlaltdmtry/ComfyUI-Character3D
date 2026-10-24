import {app} from '../../scripts/app.js';
import {api} from '../../scripts/api.js';
import {defaults,normalizeState as normalizeStateRaw,normalizeEditorState as normalizeEditorStateRaw,stableState,parseFrozen,envelope,sha256} from './state.js';
import {exportWorkflowPackage,importWorkflowPackage} from './package.js';
import {t,getLanguage,setLanguage,onLanguageChange,createLanguageControl,isLanguage} from './i18n.js';
const TYPE='Character3DEditor',CHANNEL='character-3d',PROP='character3DDraft',EDITOR_PROP='character3DEditorView';
const sessions=new Map();
let packageBusy=false;
// Only locally-created failures/validator calls establish copy provenance.
// Transport and old editor messages remain literal even on catalog collisions.
const localError=source=>Object.assign(Error(source),{i18nSource:source});
function localValidation(fn,value){try{return fn(value);}catch(e){e.i18nSource=e.message;throw e;}}
const normalizeState=value=>localValidation(normalizeStateRaw,value),normalizeEditorState=value=>localValidation(normalizeEditorStateRaw,value);
function cardError(node,error){node._character3DError=error.message;node._character3DErrorSource=typeof error.i18nSource==='string'?error.i18nSource:null;return {error:error.message,...(node._character3DErrorSource!==null?{errorSource:node._character3DErrorSource}:{})};}
const widgets=node=>Object.fromEntries((node.widgets||[]).map(w=>[w.name,w]));
const viewURL=snapshot=>snapshot?api.apiURL('/view?'+new URLSearchParams({filename:snapshot.split('/').at(-1),subfolder:'character_3d',type:'input'})):'';
const changed=node=>{node.setDirtyCanvas?.(true,true);app.graph?.change?.();};
// Locale refreshes copy only; operation handlers own preview visibility/src and gates.
function refreshCardCopy(node){
 const card=node._character3DCard;if(!card)return;
 const w=widgets(node),snapshot=w.snapshot?.value,frozen=parseFrozen(w.scene_json?.value);let dirty=false;
 try{dirty=!!node.properties?.[PROP]&&(!frozen||stableState(node.properties[PROP])!==stableState(frozen.state));}catch{dirty=true;}
 card.status.textContent=node._character3DBusy?t('Freeze: сохранение PNG…'):node._character3DError?(typeof node._character3DErrorSource==='string'?t(node._character3DErrorSource):node._character3DError):t(!snapshot?'Открой редактор → Freeze':dirty?'Черновик изменён · выход содержит прошлый Freeze':'Frozen · IMAGE готов');
 card.status.style.color=dirty||node._character3DError?'#e5bf94':'#b8d4e9';
}
function updateCard(node){
 const card=node._character3DCard;if(!card)return;refreshCardCopy(node);
 const snapshot=widgets(node).snapshot?.value;
 card.preview.hidden=!snapshot;const src=viewURL(snapshot);if(snapshot&&card.preview.getAttribute('src')!==src)card.preview.src=src;
 card.exportButton.disabled=!snapshot||!!node._character3DBusy;card.freezeButton.disabled=!!node._character3DBusy||packageBusy;
 for(const b of card.packageButtons||[])b.disabled=packageBusy||!!node._character3DBusy;
}
function validatePNG(bytes){
 const a=new Uint8Array(bytes),signature=[137,80,78,71,13,10,26,10];if(a.length<33||a.length>16*1024*1024||signature.some((b,i)=>a[i]!==b))throw localError('Freeze ожидает PNG до 16 MiB.');
 const d=new DataView(bytes),width=d.getUint32(16),height=d.getUint32(20);if(width<1||height<1||width>4096||height>4096||width*height>16000000)throw localError('PNG превышает допустимое разрешение.');
}
async function upload(png,state){
 if(!(png instanceof Blob)||png.type!=='image/png')throw localError('Редактор не передал PNG.');const original=await png.arrayBuffer();validatePNG(original);const digest=await sha256(original),scene=envelope(state,digest);if(new TextEncoder().encode(JSON.stringify(scene)).length>128*1024)throw localError('Снимок параметров превышает 128 KiB.');
 const random=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
 const form=new FormData();form.append('image',png,`c3d_${random}.png`);form.append('type','input');form.append('subfolder','character_3d');form.append('overwrite','false');
 const response=await api.fetchApi('/upload/image',{method:'POST',body:form});if(!response.ok)throw localError('Загрузка PNG: HTTP '+response.status);const saved=await response.json();
 if(saved.type!=='input'||saved.subfolder!=='character_3d'||!/^c3d_[a-f0-9]{32}(?: \([1-9][0-9]*\))?\.png$/.test(saved.name))throw localError('Сервер вернул неожиданный путь PNG.');
 const readback=await api.fetchApi('/view?'+new URLSearchParams({filename:saved.name,subfolder:saved.subfolder,type:'input'}));if(!readback.ok)throw localError('Сохранённый PNG недоступен.');const bytes=await readback.arrayBuffer();if(bytes.byteLength!==original.byteLength||await sha256(bytes)!==digest)throw localError('Сохранённый PNG отличается от отправленного.');
 return {snapshot:'character_3d/'+saved.name,scene};
}
function launch(node,freezeNow=false){
 if(node._character3DBusy||packageBusy)return;const old=sessions.get(node);if(old){old.dialog.focus();if(freezeNow)old.send('request-freeze');return;}
 node.properties||={};cardError(node,{message:''});
 const token=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
 const dialog=document.createElement('dialog');dialog.className='character3d-dialog';dialog.setAttribute('aria-label','Редактор персонажа 3D');
 Object.assign(dialog.style,{padding:'0',border:'1px solid #748da8',borderRadius:'10px',width:'min(1500px,96vw)',height:'94vh',maxWidth:'96vw',maxHeight:'96vh',background:'#20252c',overflow:'hidden',boxShadow:'0 20px 80px #0009'});
 const iframe=document.createElement('iframe');iframe.title='Редактор персонажа 3D';iframe.dataset.character3d='true';Object.assign(iframe.style,{width:'100%',height:'100%',border:'0',display:'block'});
 const url=new URL(api.apiURL('/character3d/editor/index.html'),location.href);url.searchParams.set('token',token);url.searchParams.set('lang',getLanguage());iframe.src=url.href;
 let disposed=false,applyingRemoteLanguage=false;const send=(action,payload={})=>iframe.contentWindow?.postMessage({channel:CHANNEL,token,action,...payload},location.origin);
 const localizeDialog=()=>{dialog.setAttribute('aria-label',t('Редактор персонажа 3D'));iframe.title=t('Редактор персонажа 3D');};localizeDialog();
 // Suppress only this originating session; other open editors still receive the preference.
 const unsubscribeLanguage=onLanguageChange(()=>{localizeDialog();if(!applyingRemoteLanguage)send('language',{language:getLanguage()});});
 function close(force=false){
  if(node._character3DBusy&&!force)return;
  try{const bridge=iframe.contentWindow?.character3DBridge,draft=bridge?.getDraft(),editor=bridge?.getEditorState?.();if(draft)node.properties[PROP]=normalizeState(draft);if(editor)node.properties[EDITOR_PROP]=normalizeEditorState(editor);bridge?.dispose();iframe.contentWindow?.character3D?.dispose?.();}catch{}
  disposed=true;unsubscribeLanguage();window.removeEventListener('message',onMessage);dialog.remove();sessions.delete(node);updateCard(node);changed(node);
 }
 async function onMessage(event){
  if(disposed||event.origin!==location.origin||event.source!==iframe.contentWindow||event.data?.channel!==CHANNEL||event.data.token!==token)return;
  const m=event.data;
  try{
   if(m.action==='language'){if(isLanguage(m.language)){applyingRemoteLanguage=true;try{setLanguage(m.language);}finally{applyingRemoteLanguage=false;}}}
   else if(m.action==='ready'){const frozen=parseFrozen(widgets(node).scene_json?.value);let state=frozen?.state||defaults(),editorState;try{if(node.properties[PROP])state=normalizeState(node.properties[PROP]);}catch{cardError(node,localError('Повреждённый черновик: восстановлен последний Freeze.'));}try{if(node.properties[EDITOR_PROP])editorState=normalizeEditorState(node.properties[EDITOR_PROP]);}catch{cardError(node,localError('Повреждённый рабочий вид: восстановлен вид камеры.'));}send('init',{state,editorState,frozen:frozen?.state||null,freezeNow,language:getLanguage()});updateCard(node);}
   else if(m.action==='draft'){node.properties[PROP]=normalizeState(m.state);updateCard(node);changed(node);}
   else if(m.action==='editor'){node.properties[EDITOR_PROP]=normalizeEditorState(m.editorState);changed(node);}
   else if(m.action==='freeze'){
    if(node._character3DBusy){const error=localError('Сохранение уже выполняется.');send('freeze-result',{requestId:m.requestId,error:error.message,errorSource:error.i18nSource});return;}
    node._character3DBusy=true;cardError(node,{message:''});updateCard(node);
    try{
     const state=normalizeState(m.state),frozen=await upload(m.png,state);if(disposed)return;
     const w=widgets(node);if(!w.scene_json||!w.snapshot)throw localError('Отсутствуют входы ноды.');
     // Synchronous pair commit, callbacks only after BOTH inputs are published.
     w.scene_json.value=JSON.stringify(frozen.scene);w.snapshot.value=frozen.snapshot;node.properties[PROP]=state;
     w.scene_json.callback?.(w.scene_json.value);w.snapshot.callback?.(w.snapshot.value);
     send('freeze-result',{requestId:m.requestId,snapshot:frozen.snapshot});changed(node);
    }catch(e){send('freeze-result',{requestId:m.requestId,...cardError(node,e)});console.error('[Character3D] Freeze failed',e);}
    finally{node._character3DBusy=false;updateCard(node);}
   }else if(m.action==='close')close();else if(m.action==='error'){cardError(node,m.error?{message:m.error,i18nSource:m.errorSource}:localError('Ошибка редактора'));updateCard(node);}
  }catch(e){const error=cardError(node,e);updateCard(node);send('freeze-result',{requestId:m.requestId,...error});}
 }
 window.addEventListener('message',onMessage);dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
 dialog.append(iframe);document.body.append(dialog);dialog.showModal();sessions.set(node,{dialog,send,close});updateCard(node);
}
function addCard(node){
 node._character3DCard?.dispose?.();
 const labels=[];const label=(element,source,attr)=>{labels.push([element,source,attr]);if(attr)element.setAttribute(attr,t(source));else element.textContent=t(source);};
 const root=document.createElement('div');Object.assign(root.style,{padding:'12px',boxSizing:'border-box',width:'100%',height:'100%',background:'linear-gradient(140deg,#34475c,#202a35)',color:'#e4e9f1',borderRadius:'8px',display:'flex',flexDirection:'column',gap:'8px',font:'12px Segoe UI,Arial,sans-serif',overflow:'hidden'});
 const title=document.createElement('div');title.textContent='CHARACTER / 3D';Object.assign(title.style,{letterSpacing:'2px',fontSize:'10px',color:'#b8d4e9'});
 const languageControl=createLanguageControl({document,compact:true});
 const preview=document.createElement('img');label(preview,'Последний Frozen PNG','alt');preview.hidden=true;Object.assign(preview.style,{width:'100%',flex:'1',minHeight:'0',objectFit:'contain',background:'#202b37',borderRadius:'4px'});
 const status=document.createElement('div');Object.assign(status.style,{fontSize:'11px',color:'#b8d4e9',overflowWrap:'anywhere'});preview.onerror=()=>{cardError(node,localError('PNG не найден. Открой редактор и выполни Freeze.'));updateCard(node);};
 const row=document.createElement('div');Object.assign(row.style,{display:'flex',gap:'5px',flexWrap:'wrap'});
 function button(text,fn){const b=document.createElement('button');label(b,text);Object.assign(b.style,{border:'1px solid #7e9ab8',background:'#32465f',color:'#e4e9f1',borderRadius:'5px',padding:'8px',cursor:'pointer',flex:'1',fontSize:'11px'});b.onclick=fn;row.append(b);return b;}
 button('Редактор',()=>launch(node));const freezeButton=button('Freeze',()=>launch(node,true));
 const exportButton=button('Экспорт PNG',async()=>{try{const r=await api.fetchApi(viewURL(widgets(node).snapshot.value));if(!r.ok)throw localError('Frozen PNG недоступен.');const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='character-3d-frozen.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(e){cardError(node,e);updateCard(node);}});
 label(exportButton,'Последний Freeze. Незамороженные изменения не включаются.','title');
 const packageStatus=document.createElement('div');Object.assign(packageStatus.style,{fontSize:'10px',color:'#b8d4e9',overflowWrap:'anywhere'});
 let packageMessage='',packageMessageLiteral=false,removed=false;
 const renderPackage=()=>{if(!removed)packageStatus.textContent=packageMessageLiteral?packageMessage:t(packageMessage);};
 const pickers=new Set(),showPackage=(source,{literal=false}={})=>{packageMessage=source;packageMessageLiteral=literal;renderPackage();};
 async function packageAction(fn){
  if(packageBusy||removed)return;packageBusy=true;for(const n of app.graph._nodes||[])updateCard(n);
  try{await fn();}catch(e){const local=typeof e.i18nSource==='string';showPackage(local?e.i18nSource:e.message,{literal:!local});console.error('[Character3D] Package failed',e);}
  finally{packageBusy=false;for(const n of app.graph._nodes||[])updateCard(n);}
 }
 const packageExport=button('Пакет ZIP',()=>packageAction(async()=>{
  showPackage('Проверка и упаковка workflow…');const blob=await exportWorkflowPackage(app,api),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='character.character3d.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  showPackage('ZIP передан в загрузки: workflow, черновики и Frozen PNG. Внешние ноды/модели не включены.');
 }));label(packageExport,'Все Character3D-ноды текущего workflow. PNG + черновики + сведения о совместимости. Без нового Freeze.','title');
 const packageImport=button('Импорт ZIP',()=>{
  if(packageBusy)return;if(sessions.size){showPackage('Закрой открытые 3D-редакторы перед заменой workflow.');return;}
  const picker=document.createElement('input');pickers.add(picker);picker.type='file';picker.accept='.zip,application/zip';picker.onchange=()=>{
   pickers.delete(picker);if(removed)return;const file=picker.files?.[0];if(!file)return;
   if(sessions.size){showPackage('Закрой открытые 3D-редакторы перед импортом.');return;}
   if(!window.confirm(t('Импорт заменит текущий workflow. Сохрани текущие изменения перед продолжением. Выполнение графа не запускается. Продолжить?')))return;
   packageAction(async()=>{showPackage('Проверка пакета и импорт PNG…');const r=await importWorkflowPackage(app,api,file);showPackage('Импорт пакета завершён.');window.alert(t('Импортированы Character3D-ноды: {characters}. Черновик и Freeze сохранены отдельно.\nВнешние ноды и их модели не включены: {external}.{note}',{characters:r.characters,external:(r.external_node_types||[]).join(', ')||t('нет'),note:r.version_note?'\n'+t(r.version_note):''}));});
  };picker.click();
 });label(packageImport,'Проверить ZIP и заменить workflow. Не перезаписывает существующие PNG и не запускает граф.','title');
 const hint=document.createElement('div');label(hint,'Черновик хранится в workflow. Выход меняется только после Freeze.');Object.assign(hint.style,{fontSize:'10px',color:'#a9bacd'});
 const unsubscribe=onLanguageChange(()=>{for(const [element,source,attr]of labels){if(attr)element.setAttribute(attr,t(source));else element.textContent=t(source);}renderPackage();refreshCardCopy(node);});
 root.append(title,languageControl.root,preview,status,row,packageStatus,hint);node._character3DCard={root,preview,status,exportButton,freezeButton,packageButtons:[packageExport,packageImport],dispose(){if(removed)return;removed=true;unsubscribe();languageControl.dispose();preview.onerror=null;for(const picker of pickers)picker.onchange=null;pickers.clear();for(const button of row.children)button.onclick=null;root.remove();}};
 node.addDOMWidget('character3d_panel','character3d_panel',root,{serialize:false,hideOnZoom:false,getMinHeight:()=>270,getHeight:()=>300});updateCard(node);
}
app.registerExtension({name:'Character3D.Editor',async beforeRegisterNodeDef(nodeType,nodeData){
 if(nodeData.name!==TYPE)return;
 const created=nodeType.prototype.onNodeCreated;nodeType.prototype.onNodeCreated=function(){const r=created?.apply(this,arguments);this.properties||={};for(const name of ['snapshot','scene_json']){const w=widgets(this)[name];if(w){w.hidden=true;w.type='converted-widget';w.computeSize=()=>[0,-4];if(w.inputEl)w.inputEl.style.display='none';}}addCard(this);this.setSize([360,420]);return r;};
 const serialize=nodeType.prototype.onSerialize;nodeType.prototype.onSerialize=function(){const result=serialize?.apply(this,arguments);try{const bridge=sessions.get(this)?.dialog.querySelector('iframe')?.contentWindow?.character3DBridge;for(const [key,value]of [[PROP,bridge?.getDraft()],[EDITOR_PROP,bridge?.getEditorState?.()]]){if(value){this.properties[key]=key===PROP?normalizeState(value):normalizeEditorState(value);const data=arguments[0];if(data){data.properties||={};data.properties[key]=this.properties[key];}}}}catch{}return result;};
 const configure=nodeType.prototype.onConfigure;nodeType.prototype.onConfigure=function(){const r=configure?.apply(this,arguments);queueMicrotask(()=>updateCard(this));return r;};
 const removed=nodeType.prototype.onRemoved;nodeType.prototype.onRemoved=function(){sessions.get(this)?.close(true);this._character3DCard?.dispose();delete this._character3DCard;return removed?.apply(this,arguments);};
}});
