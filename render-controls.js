import {resolveCanvas,resizeCanvas,validateCanvas} from './web/render-settings.js';
import {layoutSheet} from './sheet-layout.js';
import {t,bindText} from './i18n.js';
export function attachRenderUI({state,controller,changed,fit,copyView}){
 const $=id=>document.getElementById(id),overlay=document.createElement('div');overlay.id='camera-frame';overlay.setAttribute('aria-hidden','true');$('viewport').append(overlay);
 let locked=false,modeSource='Камера · кадр для рендера',errorSource='',disposed=false;
 const bindings=[bindText($('camera-mode-label'),()=>modeSource),bindText($('canvas-error'),()=>errorSource)];
 function sync(){
  if(disposed)return;const c=resolveCanvas(state),mode=controller.mode(),r=controller.frame();
  $('canvas-width').value=c.width;$('canvas-height').value=c.height;$('canvas-background').value=c.background;$('canvas-size').textContent=`${c.width} × ${c.height} px`;
  $('canvas-lock').checked=locked;$('canvas-preset').value=!state.canvas?'legacy':`${c.width}x${c.height}`;if(!$('canvas-preset').value)$('canvas-preset').value='custom';
  document.querySelectorAll('[data-camera-mode]').forEach(b=>{const active=(b.dataset.cameraMode==='true')===mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  modeSource=mode?'Камера · кадр для рендера':'Навигация · камера кадра сохранена';$('camera-mode-label').textContent=t(modeSource);
  overlay.hidden=!mode;Object.assign(overlay.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});
  $('camera-copy').disabled=mode;$('canvas-background').disabled=!!state.alpha;
 }
 function commit(c){c=validateCanvas(c);if(state.view==='sheet'&&state.sheet)layoutSheet(state.sheet,c.width,c.height);state.canvas=c;controller.resized();errorSource='';$('canvas-error').textContent='';sync();changed('render');}
 function run(fn){try{fn();}catch(e){errorSource=e.message;$('canvas-error').textContent=t(errorSource);sync();}}
 for(const axis of ['width','height'])$('canvas-'+axis).onchange=e=>run(()=>commit(resizeCanvas(resolveCanvas(state),axis,Number(e.target.value),locked)));
 $('canvas-background').oninput=e=>run(()=>commit({...resolveCanvas(state),background:e.target.value}));
 $('canvas-lock').onchange=e=>{locked=e.target.checked;changed('editor');};
 $('canvas-swap').onclick=()=>run(()=>{const c=resolveCanvas(state);commit({...c,width:c.height,height:c.width});});
 $('canvas-preset').onchange=e=>run(()=>{if(e.target.value==='custom')return;if(e.target.value==='legacy'){if(state.view==='sheet'&&state.sheet){const {width,height}=resolveCanvas({view:state.view});layoutSheet(state.sheet,width,height);}delete state.canvas;controller.resized();sync();changed('render');return;}const [width,height]=e.target.value.split('x').map(Number);commit({...resolveCanvas(state),width,height});});
 document.querySelectorAll('[data-camera-mode]').forEach(b=>b.onclick=()=>{controller.setMode(b.dataset.cameraMode==='true');sync();});
 $('canvas-fit').onclick=()=>{controller.setMode(true);fit();sync();};$('camera-copy').onclick=()=>{copyView();sync();};
 return {sync,metadata:()=>({aspectLock:locked}),restore:s=>{if(disposed)return;locked=!!s?.aspectLock;sync();},dispose(){if(disposed)return;disposed=true;bindings.forEach(off=>off());for(const id of ['canvas-width','canvas-height','canvas-background','canvas-lock','canvas-swap','canvas-preset','canvas-fit','camera-copy'])for(const key of ['onchange','oninput','onclick'])$(id)[key]=null;document.querySelectorAll('[data-camera-mode]').forEach(b=>b.onclick=null);overlay.remove();}};
}
