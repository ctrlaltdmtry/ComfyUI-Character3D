# SPDX-License-Identifier: MIT
"""Portable Character3D data packages. Stdlib + Pillow only; never render or execute a workflow."""
import copy,hashlib,io,json,math,os,re,stat,uuid,zipfile
from pathlib import Path

SCHEMA='character3d-package/1';STATE='character-3d-preview/1';SNAPSHOT='character-3d-snapshot/1'
SCENE='character-3d-scene/1'
ACTOR_ID=re.compile(r'[a-z][a-z0-9_-]{0,63}')
# Match ECMAScript String.trim for scene names, not Python's broader strip.
SCENE_NAME_WHITESPACE='\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
ACTOR_STATE_KEYS=frozenset(('schema','sex','morphs','pose','expressions','faceOffsets','faceSymmetry','material','skin','free','expressionPreset','expressionStrength','kinematics','view','alpha'))
ACTOR_STATE_REQUIRED=frozenset(('schema','sex','morphs','pose','expressions','faceOffsets','faceSymmetry','material','skin','free','view','alpha'))
MAX_SCENE_BYTES=128*1024
KINEMATIC='character-3d-kinematics/1';LIMB_IDS=frozenset(('arm.L','arm.R','leg.L','leg.R'))
SHEET='character-3d-sheet/1';SHEET_PRESETS=('front','left','back','right','three-quarter','face','face-left','custom')
SECTION_IDS=('scene','model','camera','canvas','sheet','material','identity','face','pose','kinematics','resources')
MAX_ARCHIVE=128*1024*1024;MAX_TOTAL=128*1024*1024;MAX_WORKFLOW=8*1024*1024;MAX_STATE=512*1024;MAX_MANIFEST=4*1024*1024;MAX_PNG=16*1024*1024;MAX_CHARACTERS=256
ROOT=Path(__file__).resolve().parent
# Pin data + rendering/state code, not package UI/backend transport. Same fingerprint is compatible.
COMPAT_FILES=('character-actor.js','scene-controller.js','scene-controls.js','scene-controls.css','web/scene-state.js','section-controls.js','section-controls.css','web/section-state.js','sheet-layout.js','sheet-renderer.js','sheet-controls.js','sheet-controls.css','web/sheet-state.js','two-bone-ik.js','kinematic-pose.js','kinematic-controls.js','web/kinematic-state.js','joint-picking.js','joint-interaction.js','rig-layers.js','rig-controls.js','camera-controller.js','render-controls.js','web/render-settings.js','index.html','style.css','viewer.js','rig-controller.js','face-controller.js','face-contact.js','eye-surface.js','editor-bridge.js','identity-morphs.js','identity-controls.js','identity-markers.js','identity.css','web/state.js','web/hash.js','vendor/three.module.js','vendor/three.core.js','vendor/OrbitControls.js','vendor/TransformControls.js','assets/human.json','assets/human.manifest.json','assets/eyes-brown.png','assets/rig.json','assets/rig.manifest.json','assets/face-rig.json','assets/face-morphs.json','assets/face-parts.json','assets/face.manifest.json','assets/face-contact.json','assets/identity.json','assets/identity.manifest.json')
SNAP_PATH=re.compile(r'character_3d/c3d_[0-9a-fA-F]{32}(?: \([1-9][0-9]{0,9}\))?\.png')
ENTRY_PATH=re.compile(r'(?:manifest\.json|workflow\.json|states/[0-9]{4}\.json|images/[0-9a-f]{64}\.png)')
HEX=re.compile(r'[0-9a-f]{64}')
class PackageError(ValueError):pass

def require(ok,message):
    if not ok:raise PackageError(message)
def digest(data):return hashlib.sha256(data).hexdigest()
def encode(value):
    try:return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')
    except (ValueError,UnicodeError,RecursionError,OverflowError) as e:raise PackageError('Invalid UTF-8 JSON values') from e
def pairs(items):
    out={}
    for k,v in items:
        require(k not in out and k not in ('__proto__','constructor','prototype'),'Duplicate or forbidden JSON key: '+k);out[k]=v
    return out
def tree(v,depth=0):
    require(depth<=32,'JSON nesting exceeds 32 levels')
    if type(v)in(int,float):require(number(v),'Nonfinite JSON number')
    elif type(v)is dict:
        for k,x in v.items():require(type(k)is str and k not in ('__proto__','constructor','prototype'),'Forbidden JSON key');tree(x,depth+1)
    elif type(v)is list:
        for x in v:tree(x,depth+1)
    else:require(v is None or type(v)in(str,bool),'Non-JSON value')
def decode(data,limit):
    require(len(data)<=limit,'JSON file exceeds its size limit')
    try:v=json.loads(data.decode('utf-8'),object_pairs_hook=pairs,parse_constant=lambda x:(_ for _ in ()).throw(PackageError('Invalid JSON constant: '+x)));tree(v);return v
    except PackageError:raise
    except (UnicodeError,ValueError,RecursionError,OverflowError) as e:raise PackageError('Invalid UTF-8 JSON') from e

def number(v):
    try:return type(v)in(int,float) and math.isfinite(v)
    except OverflowError:return False
def vector(v):return type(v)is list and len(v)==3 and all(number(x) for x in v)
def validate_kinematics(k):
    require(type(k)is dict and set(k)=={'schema','limbs'} and k.get('schema')==KINEMATIC,'Invalid kinematics schema/fields')
    limbs=k['limbs'];require(type(limbs)is dict and set(limbs)<=LIMB_IDS,'Invalid kinematics limbs')
    for controls in limbs.values():
        require(type(controls)is dict and {'target','pole'}<=set(controls)<={'target','pole','bend','direction'},'Invalid kinematics limb fields')
        for name,v in controls.items():
            bound=1000 if name in ('target','pole') else 1
            require(vector(v) and all(abs(x)<=bound for x in v),'Invalid kinematics vector: '+name)
    return k
def validate_sheet_camera(c):
    require(type(c)is dict and set(c)=={'position','target','zoom','height','near','far','up'},'Invalid sheet camera fields')
    for name in ('position','target','up'):
        bound=1 if name=='up' else 1000
        require(vector(c[name]) and all(abs(x)<=bound for x in c[name]),'Invalid sheet camera vector: '+name)
    for name,low,high in (('zoom',.01,100),('height',.001,1000),('near',0,1000),('far',0,10000)):
        require(number(c[name]) and low<=c[name]<=high,'Invalid sheet camera value: '+name)
    require(c['far']>c['near'],'Sheet camera far must exceed near')
    direction=[t-p for t,p in zip(c['target'],c['position'])]
    ds,us=max(abs(v) for v in direction),max(abs(v) for v in c['up'])
    require(ds>0 and us>0,'Sheet camera needs nonzero view and up vectors')
    d=[v/ds for v in direction];u=[v/us for v in c['up']]
    dl,ul=math.hypot(*d),math.hypot(*u)
    d=[v/dl for v in d];u=[v/ul for v in u]
    cross=(d[1]*u[2]-d[2]*u[1],d[2]*u[0]-d[0]*u[2],d[0]*u[1]-d[1]*u[0])
    require(math.hypot(*cross)>1e-12,'Sheet camera up is parallel to view')
    return c
def validate_sheet(s,canvas=None,layout=False):
    require(type(s)is dict and set(s)=={'schema','rows','columns','margin','gutter','labels','labelSize','labelColor','cells'} and s.get('schema')==SHEET,'Invalid sheet schema/fields')
    for name,low,high in (('rows',1,4),('columns',1,4),('margin',0,512),('gutter',0,512),('labelSize',8,64)):
        require(type(s[name])is int and low<=s[name]<=high,'Invalid sheet integer: '+name)
    require(type(s['labels'])is bool,'Invalid sheet labels')
    require(type(s['labelColor'])is str and re.fullmatch(r'#[0-9a-fA-F]{6}',s['labelColor'])is not None,'Invalid sheet label color')
    require(type(s['cells'])is list and len(s['cells'])==s['rows']*s['columns'],'Invalid sheet cell count')
    for cell in s['cells']:
        require(type(cell)is dict and set(cell)=={'preset','label','camera'} and cell['preset']in SHEET_PRESETS,'Invalid sheet cell fields/preset')
        label=cell['label'];require(type(label)is str and len(label)<=64 and not any(ord(c)<32 or ord(c)==127 for c in label),'Invalid sheet label')
        if cell['preset']=='custom':validate_sheet_camera(cell['camera'])
        else:require(cell['camera']is None,'Preset sheet camera must be null')
    if layout:
        width,height=(canvas['width'],canvas['height']) if canvas is not None else (1536,1536)
        columns,rows=s['columns'],s['rows']
        aw=width-2*s['margin']-(columns-1)*s['gutter'];ah=height-2*s['margin']-(rows-1)*s['gutter']
        lh=math.ceil(s['labelSize']*1.6)+8 if s['labels'] else 0
        require(aw>0 and ah>0 and all((i+1)*aw//columns-i*aw//columns>=32 for i in range(columns)) and all((i+1)*ah//rows-i*ah//rows-lh>=32 for i in range(rows)),'Sheet layout overflows canvas or image cells are smaller than 32 pixels')
    return s
def actor_id(value):
    return type(value)is str and ACTOR_ID.fullmatch(value)is not None

def validate_scene_state(s,frozen=False):
    """Validate a scene as data, sharing this contract with the PNG replay node.

    Actor records never carry cameras/editor metadata or another scene. Validate
    the aggregate byte/depth budget before descending into individual actors;
    don't upgrade legacy states, insert defaults, or synthesize a raster.
    """
    require(type(s)is dict and s.get('schema')==SCENE,'Unsupported scene state schema')
    tree(s)
    require(len(encode(s))<=MAX_SCENE_BYTES,'Scene state exceeds 128 KiB')
    required={'schema','mode','soloActor','actors','view','alpha'}
    require(required<=set(s)<=required|{'camera','canvas','sheet'},'Invalid scene root fields; editor state belongs only to editor state')
    require(type(s['mode'])is str and s['mode']in('multi','single'),'Invalid scene mode')
    require(type(s['view'])is str and s['view']in('portrait','body','sheet'),'Invalid scene view')
    require(type(s['alpha'])is bool,'Invalid scene alpha')
    actors=s['actors']
    require(type(actors)is list and 1<=len(actors)<=4,'Scene needs a dense array of 1–4 actors')
    ids=set()
    for actor in actors:
        require(type(actor)is dict and set(actor)=={'id','name','visible','position','rotation','state'},'Invalid actor record fields')
        identifier=actor['id']
        require(actor_id(identifier),'Invalid actor id')
        require(identifier not in ids,'Duplicate actor id');ids.add(identifier)
        name=actor['name']
        require(type(name)is str and bool(name) and name==name.strip(SCENE_NAME_WHITESPACE) and len(name)<=64 and not any(ord(c)<32 or ord(c)==127 for c in name),'Invalid actor name')
        require(type(actor['visible'])is bool,'Invalid actor visibility')
        for field,bound in (('position',1000),('rotation',math.pi)):
            value=actor[field]
            require(vector(value) and all(abs(x)<=bound for x in value),'Invalid actor '+field)
        state=actor['state']
        require(type(state)is dict and ACTOR_STATE_REQUIRED<=set(state)<=ACTOR_STATE_KEYS,'Invalid nested actor state fields')
        require(state.get('schema')==STATE,'Actor state must use legacy character schema')
        require(state.get('view')=='body' and state.get('alpha')is False,'Actor state must have canonical body view and alpha false')
        validate_state(state)
        if 'expressionPreset'in state:
            preset=state['expressionPreset']
            require(type(preset)is str and 1<=len(preset)<=64 and not any(ord(c)<32 or ord(c)==127 for c in preset),'Invalid actor expression preset')
    require(actor_id(s['soloActor']) and s['soloActor']in ids,'soloActor must reference an existing actor in every mode')
    if frozen or 'camera'in s:
        c=s.get('camera')
        required_camera={'position','target','zoom','height'}
        require(type(c)is dict and required_camera<=set(c)<=required_camera|{'near','far','up'},'Invalid scene camera fields')
        require(vector(c['position']) and vector(c['target']),'Invalid scene camera vectors')
        require(c['position']!=c['target'],'Scene camera position coincides with target')
        require(all(number(c[n]) and c[n]>0 for n in ('zoom','height')),'Invalid scene camera zoom/height')
        if 'up'in c:require(vector(c['up']) and any(v!=0 for v in c['up']),'Invalid scene camera up')
        for field in ('near','far'):
            if field in c:require(number(c[field]) and c[field]>=0,'Invalid scene camera '+field)
        if 'far'in c:require(c['far']>c.get('near',0),'Scene camera far must exceed near')
    if 'canvas'in s:
        c=s['canvas']
        require(type(c)is dict and set(c)=={'width','height','background'},'Invalid canvas fields')
        require(all(type(c[k])is int and 1<=c[k]<=4096 for k in ('width','height')) and c['width']*c['height']<=16000000,'Invalid canvas dimensions')
        require(type(c['background'])is str and re.fullmatch(r'#[0-9a-fA-F]{6}',c['background'])is not None,'Invalid canvas background')
    if 'sheet'in s:validate_sheet(s['sheet'],s.get('canvas'),layout=s['view']=='sheet')
    return s

def validate_state(s,frozen=False):
    if type(s)is dict and s.get('schema')==SCENE:return validate_scene_state(s,frozen)
    require(type(s)is dict and s.get('schema')==STATE,'Unsupported scene state schema');tree(s);require(len(encode(s))<=MAX_SCENE_BYTES,'Scene state exceeds 128 KiB')
    require(number(s.get('sex')) and 0<=s['sex']<=1,'Invalid sex parameter')
    require(s.get('view')in('portrait','body','sheet') and s.get('material')in('clay','skin','wire'),'Invalid view/material')
    require(type(s.get('faceSymmetry'))is bool,'Invalid faceSymmetry')
    for name in ('morphs','expressions','pose','faceOffsets'):
        m=s.get(name);require(type(m)is dict,'Missing state map: '+name)
        for k,v in m.items():require(0<len(k)<=128 and not any(ord(c)<32 for c in k),'Invalid state identifier');require(vector(v) if name in ('pose','faceOffsets') else number(v),'Invalid state map value: '+name)
    if frozen or 'camera'in s:
        c=s.get('camera');require(type(c)is dict and vector(c.get('position')) and vector(c.get('target')),'Invalid camera vectors')
        require(all(number(c.get(n)) and c[n]>0 for n in ('zoom','height')),'Invalid camera zoom/height')
    for name in ('free','alpha'):
        if name in s:require(type(s[name])is bool,'Invalid '+name)
    if 'skin'in s:require(type(s['skin'])is str and re.fullmatch(r'#[0-9a-fA-F]{6}',s['skin']) is not None,'Invalid skin color')
    if 'expressionPreset'in s:require(type(s['expressionPreset'])is str and len(s['expressionPreset'])<=128,'Invalid expression preset')
    if 'expressionStrength'in s:require(number(s['expressionStrength']) and 0<=s['expressionStrength']<=1,'Invalid expression strength')
    if 'canvas'in s:
        c=s['canvas'];require(type(c)is dict and set(c)=={'width','height','background'},'Invalid canvas fields')
        require(all(type(c[k])is int and 1<=c[k]<=4096 for k in ('width','height')) and c['width']*c['height']<=16000000,'Invalid canvas dimensions')
        require(type(c['background'])is str and re.fullmatch(r'#[0-9a-fA-F]{6}',c['background'])is not None,'Invalid canvas background')
    if 'sheet'in s:validate_sheet(s['sheet'],s.get('canvas'),layout=s['view']=='sheet')
    if 'kinematics'in s:validate_kinematics(s['kinematics'])
    require(not any(k in s for k in ('activeLimb','ikHandle','sheetCell','openSections','selectedActor')),'IK/sheet selection, openSections, and selectedActor belong only to editor state')
    require(not any(k in s for k in ('scene','actors')),'Legacy character state cannot contain scene or actors')
    return s

def scene(text):
    require(type(text)is str and bool(text.strip()),'Missing frozen scene_json')
    try:raw=text.encode('utf-8')
    except UnicodeError as e:raise PackageError('Invalid UTF-8 scene_json') from e
    s=decode(raw,MAX_SCENE_BYTES)
    require(type(s)is dict and s.get('schema')==SNAPSHOT,'Unsupported frozen snapshot schema')
    require('selectedActor'not in s,'selectedActor belongs only to editor state');validate_state(s.get('state'),True)
    require(type(s.get('png_sha256'))is str and HEX.fullmatch(s['png_sha256']) is not None,'Invalid PNG SHA256')
    require(type(s.get('description',''))is str and len(s.get('description',''))<=8192,'Invalid description');return s

def safe_root(root,create=False):
    p=Path(root).expanduser().absolute()
    require(p.resolve()==p and not p.is_symlink(),'Destination/input root is a symlink or junction')
    if create:p.mkdir(parents=True,exist_ok=True)
    require(p.is_dir(),'Input directory does not exist');return p

def file_under(root,relative):
    p=root/relative;require(p.resolve()==p and not p.is_symlink(),'Symlink/junction path refused: '+relative)
    require(p.is_file(),'Missing file: '+relative);return p

def read_limited(path,limit):
    require(path.stat().st_size<=limit,'File too large: '+path.name)
    with path.open('rb') as f:data=f.read(limit+1)
    require(len(data)<=limit,'File grew beyond limit');return data

def validate_png(raw,canvas=None):
    # Import only for actual PNG inspection: older Pillow typing imports numpy.
    from PIL import Image
    require(len(raw)<=MAX_PNG and raw[:8]==b'\x89PNG\r\n\x1a\n','Invalid or oversized PNG')
    try:
        with Image.open(io.BytesIO(raw),formats=('PNG',)) as im:
            require(0<im.width<=4096 and 0<im.height<=4096 and im.width*im.height<=16000000,'PNG dimensions exceed limits')
            if canvas is not None:require(im.size==(canvas['width'],canvas['height']),'PNG dimensions differ from frozen canvas metadata')
            im.verify()
        with Image.open(io.BytesIO(raw),formats=('PNG',)) as im:im.load()
    except (OSError,SyntaxError,Image.DecompressionBombError) as e:raise PackageError('Damaged PNG') from e

def requirements(root):
    root=safe_root(root);version=re.search(r'(?m)^version = "([0-9]+\.[0-9]+\.[0-9]+)"$',file_under(root,'pyproject.toml').read_text(encoding='utf-8'))
    require(version is not None,'Cannot identify installed Character3D version')
    files={name:digest(read_limited(file_under(root,name),64*1024*1024)) for name in COMPAT_FILES}
    return {'node':'Character3DEditor','editor_version':version.group(1),'state_schema':STATE,'scene_schema':SCENE,'snapshot_schema':SNAPSHOT,'files':files,'fingerprint':digest(encode(files))}

def characters(workflow):
    require(type(workflow)is dict and type(workflow.get('nodes'))is list,'Expected editor workflow JSON with nodes[]')
    require(len(workflow['nodes'])<=4096,'Too many workflow nodes');seen=set();out=[]
    for n in workflow['nodes']:
        require(type(n)is dict,'Invalid workflow node');i=n.get('id');require(type(i)in(int,str) and bool(str(i)) and len(str(i))<=128,'Invalid node ID');require(str(i)not in seen,'Duplicate node ID');seen.add(str(i))
        require(type(n.get('type'))is str and len(n['type'])<=256,'Invalid node type')
        if n.get('type')!='Character3DEditor':continue
        slots=n.get('inputs',[]);require(type(slots)is list,'Invalid input slots')
        for slot in slots:
            require(type(slot)is dict,'Invalid input slot')
            if slot.get('name')in('snapshot','scene_json'):require(slot.get('link') is None,'Linked/dynamic Character3D snapshot inputs cannot be packaged')
        w=n.get('widgets_values');require(type(w)is list and len(w)>=2 and type(w[0])is str and type(w[1])is str,'Missing Character3D frozen widget pair')
        if 'widgets_values_named'in n:
            named=n['widgets_values_named'];require(type(named)is dict and named.get('snapshot')==w[0] and named.get('scene_json')==w[1],'Named/positional frozen widget mismatch')
        require(type(n.get('properties',{}))is dict,'Invalid node properties');draft=n.get('properties',{}).get('character3DDraft')
        editor=n.get('properties',{}).get('character3DEditorView')
        if editor is not None:
            tree(editor)
            require(type(editor)is dict and editor.get('schema')=='character-3d-editor/1' and type(editor.get('cameraMode'))is bool and len(encode(editor))<=8192,'Invalid editor view')
            c=editor.get('viewport');require(type(c)is dict and vector(c.get('position')) and vector(c.get('target')) and all(number(c.get(k)) and c[k]>0 for k in ('zoom','height')),'Invalid navigation camera')
            if 'rigLayers'in editor:require(type(editor['rigLayers'])is dict and set(editor['rigLayers'])<={'bones','joints','controllers','body','hands','face','xray'} and all(type(v)is bool for v in editor['rigLayers'].values()),'Invalid rig layers')
            if 'jointPicking'in editor:require(type(editor['jointPicking'])is bool,'Invalid joint picking')
            if 'selectedActor'in editor:require(actor_id(editor['selectedActor']),'Invalid selected actor')
            if 'selectedJoint'in editor:require(type(editor['selectedJoint'])is str and len(editor['selectedJoint'])<=128 and not any(ord(c)<32 for c in editor['selectedJoint']),'Invalid selected joint')
            if 'activeLimb'in editor:require(type(editor['activeLimb'])is str and editor['activeLimb']in LIMB_IDS,'Invalid active limb')
            if 'ikHandle'in editor:require(editor['ikHandle']is None or (type(editor['ikHandle'])is str and editor['ikHandle']in('target','pole')),'Invalid IK handle')
            if 'sheetCell'in editor:require(type(editor['sheetCell'])is int and 0<=editor['sheetCell']<=15,'Invalid sheet cell selection')
            if 'openSections'in editor:
                sections=editor['openSections']
                require(type(sections)is list and len(sections)<=len(SECTION_IDS),'Invalid openSections: expected an array of at most '+str(len(SECTION_IDS))+' section IDs')
                require(all(type(k)is str and k in SECTION_IDS for k in sections),'Invalid openSections section ID')
                require(len(sections)==len(set(sections)),'Duplicate openSections section ID')
        if draft is not None:validate_state(draft)
        snap,text=w[:2];require(bool(snap)==bool(text),'Incomplete frozen input pair')
        parsed=None
        if snap:require(SNAP_PATH.fullmatch(snap)is not None,'Invalid source snapshot path');parsed=scene(text)
        out.append((n,{'node_id':i,'draft':draft,'scene_json':text,'png_sha256':parsed['png_sha256'] if parsed else None}))
    require(0<len(out)<=MAX_CHARACTERS,'Workflow needs 1–256 Character3D nodes');return out

def export_package(workflow,input_dir,runtime_root=ROOT):
    # Roundtrip is a data copy; no workflow mutation and no object code execution.
    workflow=decode(encode(workflow),MAX_WORKFLOW);root=safe_root(input_dir);items=characters(workflow);files={'workflow.json':encode(workflow)};records=[];total=len(files['workflow.json'])
    require(total<=MAX_TOTAL,'Package exceeds total size limit')
    for index,(n,state)in enumerate(items):
        path=f'states/{index:04d}.json';payload=encode(state);require(len(payload)<=MAX_STATE,'State record exceeds limit');total+=len(payload);require(total<=MAX_TOTAL,'Package exceeds total size limit');files[path]=payload;image=None
        if state['png_sha256']:
            raw=read_limited(file_under(root,n['widgets_values'][0]),MAX_PNG);require(digest(raw)==state['png_sha256'],'Source PNG differs from its pinned scene');image='images/'+state['png_sha256']+'.png'
            if image not in files:total+=len(raw);require(total<=MAX_TOTAL,'Package exceeds total size limit')
            validate_png(raw,json.loads(state['scene_json'])['state'].get('canvas'));files[image]=raw
        records.append({'node_id':n['id'],'state':path,'image':image})
    manifest={'schema':SCHEMA,'workflow':'workflow.json','characters':records,'requirements':requirements(runtime_root),'external_node_types':sorted({n.get('type','') for n in workflow['nodes'] if n.get('type')!='Character3DEditor'}),'files':{p:{'sha256':digest(raw),'bytes':len(raw)} for p,raw in files.items()}}
    files['manifest.json']=encode(manifest);require(len(files['manifest.json'])<=MAX_MANIFEST and sum(map(len,files.values()))<=MAX_TOTAL,'Package exceeds total size limit')
    b=io.BytesIO()
    with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p,raw in sorted(files.items()):
            info=zipfile.ZipInfo(p,(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=(stat.S_IFREG|0o600)<<16;z.writestr(info,raw)
    data=b.getvalue();require(len(data)<=MAX_ARCHIVE,'Compressed package exceeds limit');return data

def inspect_package(data,runtime_root=ROOT):
    require(type(data)is bytes and 0<len(data)<=MAX_ARCHIVE,'Invalid package size');files={}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            entries=z.infolist();require(2<=len(entries)<=600,'Invalid archive entry count');seen=set();total=0
            for info in entries:
                p=info.filename;require(info.orig_filename==p and ENTRY_PATH.fullmatch(p)is not None and p.casefold()not in seen,'Invalid/duplicate archive path: '+p);seen.add(p.casefold())
                require(not info.is_dir() and stat.S_IFMT(info.external_attr>>16)in(0,stat.S_IFREG),'Archive symlink/special file refused')
                require(not(info.flag_bits&1) and info.compress_type in(zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED),'Encrypted/unsupported ZIP entry')
                limit=MAX_MANIFEST if p=='manifest.json' else MAX_WORKFLOW if p=='workflow.json' else MAX_STATE if p.startswith('states/') else MAX_PNG
                require(0<=info.file_size<=limit,'ZIP entry too large');total+=info.file_size;require(total<=MAX_TOTAL,'ZIP total too large')
                with z.open(info) as f:raw=f.read(limit+1)
                require(len(raw)==info.file_size and len(raw)<=limit,'ZIP size mismatch');files[p]=raw
    except (zipfile.BadZipFile,RuntimeError,EOFError,OSError) as e:raise PackageError('Damaged or unsupported ZIP') from e
    require('manifest.json'in files and 'workflow.json'in files,'Missing package manifest/workflow');m=decode(files['manifest.json'],MAX_MANIFEST)
    require(type(m)is dict and m.get('schema')==SCHEMA and m.get('workflow')=='workflow.json','Unsupported package schema')
    index=m.get('files');require(type(index)is dict and set(index)==set(files)-{'manifest.json'},'Manifest file set mismatch')
    for p,meta in index.items():require(type(meta)is dict and type(meta.get('bytes'))is int and meta['bytes']==len(files[p]) and meta.get('sha256')==digest(files[p]),'File hash/size mismatch: '+p)
    expected=requirements(runtime_root);r=m.get('requirements');require(type(r)is dict and r.get('node')==expected['node'] and r.get('state_schema')==STATE and r.get('snapshot_schema')==SNAPSHOT,'Incompatible state/snapshot requirements')
    require('scene_schema'not in r or r['scene_schema']==SCENE,'Incompatible scene requirements')
    require(r.get('files')==expected['files'] and r.get('fingerprint')==expected['fingerprint'],'Incompatible renderer/assets. Install the matching Character3D runtime; data was not imported.')
    require(type(r.get('editor_version'))is str and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',r['editor_version'])is not None,'Invalid editor version')
    workflow=decode(files['workflow.json'],MAX_WORKFLOW);items=characters(workflow);records=m.get('characters');require(type(records)is list and len(records)==len(items),'Character index mismatch')
    used={'workflow.json'}
    for i,((n,state),rec)in enumerate(zip(items,records)):
        path=f'states/{i:04d}.json';image='images/'+state['png_sha256']+'.png' if state['png_sha256'] else None
        require(type(rec)is dict and encode(rec)==encode({'node_id':n['id'],'state':path,'image':image}),'Character mapping mismatch');require(path in files and encode(decode(files[path],MAX_STATE))==encode(state),'Draft/frozen state mismatch');used.add(path)
        if image:require(image in files and digest(files[image])==state['png_sha256'],'Pinned PNG mismatch');validate_png(files[image],json.loads(state['scene_json'])['state'].get('canvas'));used.add(image)
    require(used==set(index),'Unreferenced package payload')
    require(m.get('external_node_types')==sorted({n.get('type','') for n in workflow['nodes'] if n.get('type')!='Character3DEditor'}),'External node requirements mismatch')
    return {'workflow':workflow,'manifest':m,'files':files,'characters':items,'version_note':None if r['editor_version']==expected['editor_version'] else 'Editor version differs; exact renderer/assets fingerprint matches.'}

def import_package(data,input_dir,runtime_root=ROOT):
    package=inspect_package(data,runtime_root)  # Validate EVERYTHING before any destination write.
    root=safe_root(input_dir,True);target=root/'character_3d';require(target.resolve()==target and not target.is_symlink(),'Snapshot destination is a symlink or junction');target.mkdir(exist_ok=True)
    mapping={};created=[]
    # Never overwrite or silently reuse any existing file, even if a same-named file is identical.
    for _n,state in package['characters']:
        sha=state['png_sha256']
        if not sha or sha in mapping:continue
        raw=package['files']['images/'+sha+'.png']
        for _ in range(32):
            name='c3d_'+uuid.uuid4().hex+'.png';p=target/name
            require(p.resolve()==p and not p.is_symlink(),'Unexpected destination link')
            try:
                with p.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
                break
            except FileExistsError:continue
        else:raise PackageError('Cannot allocate a unique snapshot filename')
        require(digest(read_limited(p,MAX_PNG))==sha,'Imported PNG readback differs');mapping[sha]='character_3d/'+name;created.append(mapping[sha])
    workflow=copy.deepcopy(package['workflow'])
    for n,_state in characters(workflow):
        if n['widgets_values'][0]:
            n['widgets_values'][0]=mapping[scene(n['widgets_values'][1])['png_sha256']]
            if 'widgets_values_named'in n:n['widgets_values_named']['snapshot']=n['widgets_values'][0]
    # Verify rewritten bindings against bytes, leaving draft/scene_json and all other nodes unchanged.
    for n,state in characters(workflow):
        if state['png_sha256']:require(digest(read_limited(file_under(root,n['widgets_values'][0]),MAX_PNG))==state['png_sha256'],'Rebound snapshot mismatch')
    return {'workflow':workflow,'created_snapshots':created,'characters':len(package['characters']),'external_node_types':package['manifest']['external_node_types'],'version_note':package['version_note']}

def write_new(path,data):
    path=Path(path).expanduser().absolute();require(path.resolve()==path and not path.is_symlink(),'Output path is a symlink/junction');require(path.parent.is_dir(),'Output parent directory does not exist')
    require(path.name==path.name.rstrip(' .') and ':'not in path.name and not re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',path.name,re.I),'Invalid/reserved output filename')
    # Publish a complete checked file atomically and without replacement. NTFS hardlinks do not require symlink privilege.
    if path.exists():raise FileExistsError(str(path))
    temporary=path.parent/('._character3d_'+uuid.uuid4().hex+'.tmp')
    with temporary.open('xb') as f:
        try:
            f.write(data);f.flush();os.fsync(f.fileno())
        except BaseException:
            f.close();temporary.unlink();raise
    try:
        require(read_limited(temporary,len(data))==data,'Output staging readback mismatch')
        os.link(temporary,path)  # Fails if destination exists, unlike POSIX rename.
        require(read_limited(path,len(data))==data,'Output readback mismatch')
    finally:temporary.unlink()
    return path
