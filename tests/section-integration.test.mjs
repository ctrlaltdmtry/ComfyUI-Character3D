import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizeEditorState,normalizeState,stableState,defaults,envelope} from '../web/state.js';
const editor=()=>({schema:'character-3d-editor/1',cameraMode:true,viewport:{position:[0,1,10],target:[0,1,0],zoom:1,height:4}});
test('editor omission stays absent; explicit empty list survives; canonical copy detached',()=>{
 const legacy=editor();assert.deepEqual(normalizeEditorState(legacy),legacy);
 assert.deepEqual(normalizeEditorState({...legacy,openSections:[]}).openSections,[]);
 const raw={...legacy,openSections:['pose','camera']},result=normalizeEditorState(raw);
 assert.deepEqual(result.openSections,['camera','pose']);assert.deepEqual(raw.openSections,['pose','camera']);
 result.openSections.push('identity');assert.deepEqual(raw.openSections,['pose','camera']);
});
test('editor selections never enter render hash/envelope or normalizeState',()=>{
 const s=defaults(),before=stableState(s),frozen=envelope(s,'a'.repeat(64));
 for(const openSections of [[],['identity'],['camera','pose']]){
  normalizeEditorState({...editor(),openSections});assert.equal(stableState(s),before);
  assert.deepEqual(envelope(s,'a'.repeat(64)),frozen);assert.throws(()=>normalizeState({...s,openSections}),/рабочему виду|редактора/);
 }
});
test('viewer wires tile metadata, restore, disposal after dynamically mounted panels',()=>{
 const s=fs.readFileSync(new URL('../viewer.js',import.meta.url),'utf8');
 assert.match(s,/\.\.\.sectionUI\?\.metadata\(\)/);assert.match(s,/sectionUI\?\.restore\(editor\)/);
 assert.match(s,/sectionUI\?\.dispose\(\)/);
 assert.ok(s.indexOf('sectionUI=attachSectionUI')>s.indexOf('if(hasFaceRig)faceUI=attachFaceUI'));
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 for(const id of ['model','camera','canvas','material','identity','resources'])assert.match(html,new RegExp('<section id="'+id+'-panel"'));
 assert.match(html,/href="\.\/section-controls\.css"/);
});
