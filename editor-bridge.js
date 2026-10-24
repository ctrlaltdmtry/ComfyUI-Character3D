import {normalizeState as normalizeStateRaw,normalizeEditorState as normalizeEditorStateRaw,stableState} from './web/state.js';
import {t,getLanguage,setLanguage,onLanguageChange,isLanguage} from './i18n.js';
const CHANNEL='character-3d';
function localValidation(fn,value){try{return fn(value);}catch(e){e.i18nSource=e.message;throw e;}}
const normalizeState=value=>localValidation(normalizeStateRaw,value),normalizeEditorState=value=>localValidation(normalizeEditorStateRaw,value);
const errorPayload=e=>({error:e.message,...(typeof e.i18nSource==='string'?{errorSource:e.i18nSource}:{})});
export function connectEditor(api){
 const token=new URLSearchParams(location.search).get('token');
 if(window.parent===window||!/^[a-f0-9]{32}$/.test(token||''))return null;
 const freeze=document.querySelector('#freeze'),close=document.querySelector('#close-editor'),status=document.querySelector('#status');
 const send=(action,payload={})=>{if(!disposed)parent.postMessage({channel:CHANNEL,token,action,...payload},location.origin);};
 let initialized=false,busy=false,disposed=false,frozen=null,last='',lastEditor='',timer,requestId,timeout;
 // Canonical sources let existing failures follow the locale without losing backend details.
 let statusSource=null,statusParams={},statusLiteral=false,statusErrorSource=null,lastStatusText=null;
 // Received details are literal; only explicit local provenance translates them.
 const renderStatus=()=>{if(statusSource===null)return;const params=statusErrorSource===null?statusParams:{...statusParams,error:t(statusErrorSource)},next=statusLiteral?statusSource:t(statusSource,params);if(lastStatusText!==null&&status.textContent!==lastStatusText&&status.textContent!==next){statusSource=null;lastStatusText=null;return;}status.textContent=next;lastStatusText=next;};
 function showStatus(source,params={}, {literal=false,errorSource=null}={}){statusSource=source;statusParams=params;statusLiteral=literal;statusErrorSource=errorSource;lastStatusText=null;renderStatus();}
 const showError=e=>showStatus(typeof e.i18nSource==='string'?e.i18nSource:e.message,{}, {literal:typeof e.i18nSource!=='string'});
 // Viewer Load/Export copy shares this owner while idle, never during a Freeze transaction.
 const setViewerStatus=(source,params={})=>{if(disposed||busy)return false;showStatus(source,params);return true;};
 const renderLabels=()=>{freeze.textContent=t('Freeze → нода');close.textContent=t('Закрыть');document.querySelector('.tag').textContent=t('ComfyUI · черновик');renderStatus();};
 freeze.hidden=false;close.hidden=false;freeze.disabled=true;document.body.dataset.comfyEditor='true';renderLabels();
 let applyingRemoteLanguage=false;
 const applyRemoteLanguage=language=>{if(!isLanguage(language))return;applyingRemoteLanguage=true;try{setLanguage(language);}finally{applyingRemoteLanguage=false;}};
 const unsubscribeLanguage=onLanguageChange(()=>{renderLabels();if(!applyingRemoteLanguage)send('language',{language:getLanguage()});});
 function flush(){if(!initialized||disposed)return null;const state=normalizeState(api.getState()),key=stableState(state);if(key!==last){last=key;send('draft',{state});}if(api.getEditorState){const editorState=normalizeEditorState(api.getEditorState()),key=JSON.stringify(editorState);if(key!==lastEditor){lastEditor=key;send('editor',{editorState});}}return state;}
 function changed(){if(!initialized||busy||disposed)return;clearTimeout(timer);timer=setTimeout(()=>{try{flush();}catch(e){send('error',errorPayload(e));}},60);}
 let disabledBefore=[];
 function lock(value){busy=value;if(value){disabledBefore=Array.from(document.querySelectorAll('button,input,select')).map(e=>[e,e.disabled]);for(const [e]of disabledBefore)e.disabled=true;}else{for(const [e,d]of disabledBefore)e.disabled=d;disabledBefore=[];}document.body.classList.toggle('capture-locked',value);freeze.disabled=value||!initialized;close.disabled=value;}
 function result(message){if(disposed||message.requestId!==requestId||!busy)return;clearTimeout(timeout);lock(false);if(message.error){showStatus('Freeze не выполнен: {error}',{error:message.error},{errorSource:typeof message.errorSource==='string'?message.errorSource:null});send('draft',{state:normalizeState(api.getState())});}else{frozen=normalizeState(api.getState());showStatus('Frozen PNG сохранён. Новые изменения попадут в выход только после следующего Freeze.');}requestId=null;}
 async function capture(){
  if(!initialized||busy||disposed)return;lock(true);requestId=crypto.randomUUID();showStatus('Freeze: рендер и сохранение PNG…');
  try{clearTimeout(timer);const state=normalizeState(api.getState());const png=await api.exportPNG();if(disposed)return;send('freeze',{requestId,state,png});timeout=setTimeout(()=>{const error='Сервер не ответил. Прошлый Freeze сохранён.';result({requestId,error,errorSource:error});},30000);}catch(e){if(disposed)return;lock(false);requestId=null;showError(e);send('error',errorPayload(e));}
 }
 function onMessage(e){
  if(disposed||e.origin!==location.origin||e.source!==parent||e.data?.channel!==CHANNEL||e.data.token!==token)return;
  const m=e.data;
  try{
   if(m.action==='language')applyRemoteLanguage(m.language);
   else if(m.action==='init'&&!initialized){applyRemoteLanguage(m.language);api.setState(m.state);if(m.editorState&&api.setEditorState)api.setEditorState(normalizeEditorState(m.editorState));initialized=true;frozen=m.frozen||null;freeze.disabled=false;flush();showStatus(frozen?'Черновик открыт. Выход ноды сохраняет последний Freeze.':'Черновик открыт. Нажми Freeze для передачи изображения в граф.');if(m.freezeNow)capture();}
   else if(m.action==='request-freeze')capture();
   else if(m.action==='freeze-result')result(m);
  }catch(err){showError(err);send('error',errorPayload(err));}
 }
 window.addEventListener('message',onMessage);window.addEventListener('character3d:change',changed);
 const previousFreeze=freeze.onclick,previousClose=close.onclick,closeEditor=()=>{if(!busy&&!disposed){flush();send('close');}};
 freeze.onclick=capture;close.onclick=closeEditor;
 const bridge={getDraft:()=>initialized?normalizeState(api.getState()):null,getEditorState:()=>initialized&&api.getEditorState?normalizeEditorState(api.getEditorState()):null,flush,freeze:capture,setViewerStatus,initialized:()=>initialized,busy:()=>busy,dispose:()=>{if(disposed)return;disposed=true;unsubscribeLanguage();clearTimeout(timer);clearTimeout(timeout);window.removeEventListener('message',onMessage);window.removeEventListener('character3d:change',changed);if(freeze.onclick===capture)freeze.onclick=previousFreeze;if(close.onclick===closeEditor)close.onclick=previousClose;if(busy)lock(false);}};
 window.character3DBridge=bridge;send('ready');return bridge;
}
