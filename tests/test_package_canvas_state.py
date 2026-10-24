"""CPU-only package validation of independently saved canvas/editor state."""
import copy,json,unittest,io
from PIL import Image
import portable_package as p

def state():return {'schema':p.STATE,'sex':0,'view':'portrait','material':'clay','faceSymmetry':True,'morphs':{},'expressions':{},'pose':{},'faceOffsets':{},'camera':{'position':[0,1,10],'target':[0,1,0],'height':4,'zoom':1}}
def workflow():return {'nodes':[{'id':1,'type':'Character3DEditor','widgets_values':['',''],'properties':{'character3DDraft':state(),'character3DEditorView':{'schema':'character-3d-editor/1','cameraMode':False,'viewport':state()['camera']}}}]}
class CanvasPackageStateTests(unittest.TestCase):
 def test_legacy_stays_unchanged(self):
  s=state();before=p.encode(s);p.validate_state(s);self.assertEqual(before,p.encode(s));self.assertNotIn('canvas',s)
 def test_valid_canvas(self):
  s=state();s['canvas']={'width':512,'height':768,'background':'#abcdef'};self.assertIs(p.validate_state(s),s)
 def test_bad_dimensions_and_color(self):
  for value in (True,False,0,-1,4097,1.5,'512',None):
   with self.subTest(value=value):
    s=state();s['canvas']={'width':value,'height':512,'background':'#333e4a'}
    with self.assertRaises(p.PackageError):p.validate_state(s)
  for c in ({'width':4096,'height':4096,'background':'#333e4a'},{'width':512,'height':512,'background':'red'},{'width':512,'height':512,'background':'#333e4a','extra':True}):
   with self.assertRaises(p.PackageError):p.validate_state({**state(),'canvas':c})
 def test_editor_separate_from_render(self):
  w=workflow();before=p.encode(w['nodes'][0]['properties']['character3DDraft']);p.characters(w);w['nodes'][0]['properties']['character3DEditorView']['viewport']['position'][0]=9;p.characters(w);self.assertEqual(before,p.encode(w['nodes'][0]['properties']['character3DDraft']))
 def test_png_size_must_match_frozen_canvas(self):
  f=io.BytesIO();Image.new('RGBA',(3,2),(120,60,30,128)).save(f,format='PNG');raw=f.getvalue()
  p.validate_png(raw,{'width':3,'height':2,'background':'#000000'})
  with self.assertRaisesRegex(p.PackageError,'dimensions differ'):p.validate_png(raw,{'width':4,'height':2,'background':'#000000'})
 def test_bad_editor_rejected(self):
  for key,value in [('cameraMode',1),('schema','other'),('viewport',{'position':[0,1],'target':[0,1,0],'height':1,'zoom':1})]:
   w=workflow();w['nodes'][0]['properties']['character3DEditorView'][key]=value
   with self.assertRaises(p.PackageError):p.characters(w)
 def test_rig_metadata_separate_and_strict(self):
  w=workflow();e=w['nodes'][0]['properties']['character3DEditorView'];d=copy.deepcopy(w['nodes'][0]['properties']['character3DDraft']);e.update(rigLayers={'bones':True,'joints':False,'controllers':True,'body':True,'hands':False,'face':True,'xray':False},jointPicking=True,selectedJoint='jaw');p.characters(w);self.assertEqual(d,w['nodes'][0]['properties']['character3DDraft'])
  for bad in ({'rigLayers':[]},{'rigLayers':{'bones':1}},{'rigLayers':{'alien':True}},{'jointPicking':1},{'selectedJoint':3},{'selectedJoint':'x'*129},{'selectedJoint':'a\x00'}):
   a=copy.deepcopy(w);a['nodes'][0]['properties']['character3DEditorView'].update(bad)
   with self.subTest(bad=bad),self.assertRaises(p.PackageError):p.characters(a)
if __name__=='__main__':unittest.main()
