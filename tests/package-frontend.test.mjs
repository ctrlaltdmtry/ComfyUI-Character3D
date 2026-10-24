// CPU-only frontend contract tests; API/graph doubles are labelled, not live ComfyUI evidence.
import assert from 'node:assert/strict';
import {exportWorkflowPackage,importWorkflowPackage} from '../web/package.js';
let calls=[],loaded=null;const workflow={nodes:[{id:1,type:'Character3DEditor',widgets_values:['immutable.png','frozen'],properties:{character3DDraft:{sex:1}}}]};
const app={graph:{_nodes:[],serialize:()=>structuredClone(workflow)},loadGraphData:async w=>{loaded=w;}};
const blob=new Blob(['ZIP unit fixture'],{type:'application/zip'});
const api={fetchApi:async(path,opts)=>{calls.push({path,opts});return path.endsWith('/export')?new Response(blob):new Response(JSON.stringify({workflow,characters:1,created_snapshots:['new.png'],external_node_types:[]}));}};
assert.equal(await (await exportWorkflowPackage(app,api)).text(),await blob.text());assert.equal(calls[0].path,'/character3d/package/export');assert.deepEqual(JSON.parse(calls[0].opts.body),workflow);
const r=await importWorkflowPackage(app,api,blob);assert.equal(r.characters,1);assert.deepEqual(loaded,workflow);assert.equal(calls[1].path,'/character3d/package/import');assert.equal(calls[1].opts.body,blob);
loaded=null;const failing={fetchApi:async()=>new Response(JSON.stringify({error:'Incompatible assets'}),{status:400})};await assert.rejects(()=>importWorkflowPackage(app,failing,blob),/Incompatible assets/);assert.equal(loaded,null);
app.graph._nodes=[{_character3DBusy:true}];const before=calls.length;await assert.rejects(()=>exportWorkflowPackage(app,api),/Freeze/);await assert.rejects(()=>importWorkflowPackage(app,api,blob),/Freeze/);assert.equal(calls.length,before);
app.graph._nodes=[];await assert.rejects(()=>importWorkflowPackage(app,api,new Blob([])),/ZIP/);await assert.rejects(()=>importWorkflowPackage(app,api,{size:129*1024*1024}),/ZIP/);
console.log('PASS frontend package contract: export current serialized graph; import verified graph; no graph replacement on HTTP failure; freeze locks; size checks. No renderer/GPU/browser.');
