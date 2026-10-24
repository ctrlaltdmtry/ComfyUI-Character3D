// Portable workflow data only. Never opens the viewer, creates WebGL, freezes or queues a graph.
import {t} from './i18n.js';
// Retain the exact source for live status retranslation; explicit server errors stay literal.
const localError=source=>Object.assign(Error(t(source)),{i18nSource:source});
export async function exportWorkflowPackage(app,api){
 if(app.graph._nodes?.some(n=>n._character3DBusy))throw localError('Дождись завершения Freeze перед экспортом пакета.');
 const workflow=app.graph.serialize(),body=JSON.stringify(workflow);
 if(new TextEncoder().encode(body).length>8*1024*1024)throw localError('Workflow превышает 8 MiB.');
 const r=await api.fetchApi('/character3d/package/export',{method:'POST',headers:{'Content-Type':'application/json'},body});
 if(!r.ok){let e;try{e=await r.json();}catch{}throw e?.error?Error(e.error):localError('Экспорт пакета: HTTP '+r.status);}
 return r.blob();
}
export async function importWorkflowPackage(app,api,file){
 if(!file||file.size<1||file.size>128*1024*1024)throw localError('Ожидается ZIP-пакет до 128 MiB.');
 if(app.graph._nodes?.some(n=>n._character3DBusy))throw localError('Дождись завершения Freeze перед импортом.');
 const r=await api.fetchApi('/character3d/package/import',{method:'POST',headers:{'Content-Type':'application/zip'},body:file});
 if(!r.ok){let e;try{e=await r.json();}catch{}throw e?.error?Error(e.error):localError('Импорт пакета: HTTP '+r.status);}
 const result=await r.json();
 if(!result.workflow?.nodes||!Number.isInteger(result.characters))throw localError('Сервер не вернул проверенный workflow.');
 await app.loadGraphData(result.workflow); // No auto-queue; preserve server-returned draft and frozen state.
 return result;
}
