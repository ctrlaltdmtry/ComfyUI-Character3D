import {sha256Fallback} from './hash.js';
import {validateCanvas} from './render-settings.js';
import {validateKinematics,limbIds} from './kinematic-state.js';
import {validateSheet,layoutSheet} from './sheet-state.js';
import {resolveCanvas} from './render-settings.js';
import {validateOpenSections} from './section-state.js';
import {isSceneState,validateSceneState,validateActorId} from './scene-state.js';
// Pure shared state helpers; safe when ComfyUI auto-imports web modules.
export const STATE_SCHEMA='character-3d-preview/1';
export const SNAPSHOT_SCHEMA='character-3d-snapshot/1';
export function defaults(){return {schema:STATE_SCHEMA,sex:0,morphs:{},pose:{},expressions:{},faceOffsets:{},faceSymmetry:true,view:'portrait',material:'clay',skin:'#b98570',free:false,alpha:false,expressionPreset:'neutral',expressionStrength:1};}
function clone(value,depth=0){
 if(depth>16)throw Error('Слишком глубокая структура параметров.');
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Параметры содержат нечисловое значение.');return value;}
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(Array.isArray(value)){const result=[];for(let i=0;i<value.length;i++)result.push(clone(value[i],depth+1));return result;}
 if(value&&Object.prototype.toString.call(value)==='[object Object]'&&(Object.getPrototypeOf(value)===null||Object.getPrototypeOf(Object.getPrototypeOf(value))===null)){const result={};for(const k of Object.keys(value).sort()){if(['__proto__','constructor','prototype'].includes(k))throw Error('Недопустимый ключ параметров.');result[k]=clone(value[k],depth+1);}return result;}
 throw Error('Некорректные параметры персонажа.');
}
export function normalizeState(input){
 if(isSceneState(input))return validateSceneState(input,normalizeState);
 if(!input||typeof input!=='object'||Array.isArray(input)||input.schema!==STATE_SCHEMA)throw Error('Неизвестная схема персонажа.');
 const result=clone(input);if(new TextEncoder().encode(JSON.stringify(result)).length>128*1024)throw Error('Параметры превышают 128 KiB.');
 for(const key of ['morphs','pose','expressions','faceOffsets']){if(!result[key]||typeof result[key]!=='object'||Array.isArray(result[key]))throw Error('Некорректный раздел '+key);for(const [id,v]of Object.entries(result[key])){if(key==='pose'||key==='faceOffsets'){if(!Array.isArray(v)||v.length!==3||!v.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('Некорректная кость '+id);if(v.every(x=>x===0))delete result[key][id];}else{if(typeof v!=='number'||!Number.isFinite(v))throw Error('Некорректный параметр '+id);if(v===0)delete result[key][id];}}}
 if(typeof result.sex!=='number'||result.sex<0||result.sex>1||!['portrait','body','sheet'].includes(result.view)||!['clay','skin','wire'].includes(result.material))throw Error('Некорректный пол, вид или материал.');
 if(Object.hasOwn(result,'canvas'))validateCanvas(result.canvas);
 if(Object.hasOwn(result,'kinematics'))result.kinematics=validateKinematics(result.kinematics);
 if(Object.hasOwn(result,'sheet')){result.sheet=validateSheet(result.sheet);if(result.view==='sheet'){const c=resolveCanvas(result);layoutSheet(result.sheet,c.width,c.height);}}
 if(Object.hasOwn(result,'openSections'))throw Error('Выбор разделов относится только к рабочему виду редактора.');
 if(Object.hasOwn(result,'selectedActor'))throw Error('Выбор персонажа относится только к рабочему виду редактора.');
 if(Object.hasOwn(result,'sheetCell'))throw Error('Выбор ячейки относится к рабочему виду редактора.');
 if(Object.hasOwn(result,'activeLimb')||Object.hasOwn(result,'ikHandle'))throw Error('Выбор цепи и контроллера относится к рабочему виду редактора.');
 return result;
}
export function normalizeEditorState(input){
 const s=clone(input),c=s?.viewport;
 if(!s||s.schema!=='character-3d-editor/1'||typeof s.cameraMode!=='boolean'||!c||typeof c!=='object'||['position','target'].some(k=>!Array.isArray(c[k])||c[k].length!==3||!c[k].every(x=>typeof x==='number'&&Number.isFinite(x)))||['zoom','height'].some(k=>typeof c[k]!=='number'||!Number.isFinite(c[k])||c[k]<=0))throw Error('Некорректный рабочий вид редактора.');
 if(new TextEncoder().encode(JSON.stringify(s)).length>8192)throw Error('Рабочий вид превышает 8 KiB.');
 if(Object.hasOwn(s,'rigLayers')){if(!s.rigLayers||typeof s.rigLayers!=='object'||Array.isArray(s.rigLayers)||Object.entries(s.rigLayers).some(([k,v])=>!['bones','joints','controllers','body','hands','face','xray'].includes(k)||typeof v!=='boolean'))throw Error('Некорректные слои рига.');}
 if(Object.hasOwn(s,'jointPicking')&&typeof s.jointPicking!=='boolean')throw Error('Некорректный выбор суставов.');
 if(Object.hasOwn(s,'selectedJoint')&&(typeof s.selectedJoint!=='string'||s.selectedJoint.length>128||/[\x00-\x1f]/.test(s.selectedJoint)))throw Error('Некорректный выбранный сустав.');
 if(Object.hasOwn(s,'sheetCell')&&(!Number.isInteger(s.sheetCell)||s.sheetCell<0||s.sheetCell>15))throw Error('Некорректная выбранная ячейка листа.');
 if(Object.hasOwn(s,'activeLimb')&&!limbIds.includes(s.activeLimb))throw Error('Некорректная активная цепь FK/IK.');
 if(Object.hasOwn(s,'ikHandle')&&s.ikHandle!==null&&!['target','pole'].includes(s.ikHandle))throw Error('Некорректный контроллер IK.');
 if(Object.hasOwn(s,'openSections'))s.openSections=validateOpenSections(s.openSections);
 if(Object.hasOwn(s,'selectedActor'))s.selectedActor=validateActorId(s.selectedActor);
 return s;
}
export function stableState(input){const s=normalizeState(input);return JSON.stringify(s,(_k,v)=>typeof v==='number'?Number(v.toFixed(9)):v);}
export function parseFrozen(text){try{const s=JSON.parse(text);if(s.schema!==SNAPSHOT_SCHEMA||!/^[a-f0-9]{64}$/.test(s.png_sha256))return null;normalizeState(s.state);return s;}catch{return null;}}
export function envelope(state,png_sha256){if(!/^[a-f0-9]{64}$/.test(png_sha256))throw Error('Некорректный SHA256 PNG.');return {schema:SNAPSHOT_SCHEMA,state:normalizeState(state),png_sha256,description:''};}
export async function sha256(bytes){if(!globalThis.crypto?.subtle)return sha256Fallback(bytes);const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
