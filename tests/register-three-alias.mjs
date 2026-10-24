// CPU-only production-module import map, matching the editor's actual vendored Three.
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier==='three')return {url:new URL('../vendor/three.module.js',import.meta.url).href,shortCircuit:true};return next(specifier,context);}});
