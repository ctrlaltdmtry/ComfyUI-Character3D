// Pure output-frame contract. Missing canvas keeps legacy render dimensions untouched.
export const MAX_SIDE=4096,MAX_PIXELS=16000000;
export function validateCanvas(input){
 if(!input||Object.prototype.toString.call(input)!=='[object Object]'||Object.keys(input).sort().join(',')!=='background,height,width')throw Error('Холст должен содержать ширину, высоту и цвет фона.');
 for(const key of ['width','height'])if(typeof input[key]!=='number'||!Number.isInteger(input[key])||input[key]<1||input[key]>MAX_SIDE)throw Error('Размер холста: целое число от 1 до 4096.');
 if(input.width*input.height>MAX_PIXELS)throw Error('Холст превышает 16 мегапикселей.');
 if(typeof input.background!=='string'||!/^#[0-9a-f]{6}$/i.test(input.background))throw Error('Цвет фона: #RRGGBB.');
 return {width:input.width,height:input.height,background:input.background};
}
export function resolveCanvas(state){
 if(Object.hasOwn(state,'canvas'))return validateCanvas(state.canvas);
 if(!['portrait','body','sheet'].includes(state.view))throw Error('Неизвестный вид кадра.');
 return {width:state.view==='sheet'?1536:1024,height:state.view==='portrait'?1024:1536,background:'#333e4a'};
}
export function resizeCanvas(input,axis,value,locked=false){
 const c=validateCanvas(input);if(!['width','height'].includes(axis))throw Error('Неизвестная сторона холста.');
 if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>MAX_SIDE)throw Error('Размер холста: целое число от 1 до 4096.');
 const result={...c,[axis]:value};if(locked)result[axis==='width'?'height':'width']=Math.round(axis==='width'?value*c.height/c.width:value*c.width/c.height);
 return validateCanvas(result);
}
