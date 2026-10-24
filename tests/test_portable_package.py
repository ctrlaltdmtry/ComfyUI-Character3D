"""CPU-only package regressions using an existing REAL renderer Freeze PNG.
Synthetic malformed ZIP/JSON/PNG fixtures are negative tests, never product evidence.
"""
import copy,io,json,os,stat,sys,tempfile,unittest,zipfile
from pathlib import Path
from unittest import mock
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import portable_package as p
SCRATCH=Path.home()/'AppData/Local/hermes/cache/scratch';SOURCE=SCRATCH/'character3d-comfy-test/input'

class PackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow=json.loads((ROOT/'examples/character3d-frozen-workflow.json').read_text(encoding='utf-8'))
        cls.character=next(n for n in cls.workflow['nodes'] if n['type']=='Character3DEditor')
        # Scratch is pruned; use the durable original raster with its pinned digest.
        from frozen_fixture import stage_frozen_fixture
        global SOURCE
        fixture=tempfile.TemporaryDirectory(prefix='c3d-package-source-',dir=SCRATCH);cls.addClassCleanup(fixture.cleanup)
        SOURCE=Path(fixture.name)/'input'
        cls.png=stage_frozen_fixture(SOURCE,cls.workflow)
        cls.bundle=p.export_package(cls.workflow,SOURCE)
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='c3d-package-',dir=SCRATCH);self.addCleanup(self.temp.cleanup);self.dest=Path(self.temp.name)/'input'
    def unpack(self,data=None):
        with zipfile.ZipFile(io.BytesIO(data or self.bundle)) as z:return {i.filename:z.read(i) for i in z.infolist()}
    def repack(self,files,reindex=False):
        if reindex:
            m=json.loads(files['manifest.json']);m['files']={k:{'bytes':len(v),'sha256':p.digest(v)} for k,v in files.items() if k!='manifest.json'};files['manifest.json']=p.encode(m)
        b=io.BytesIO()
        with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
            for k,v in files.items():z.writestr(k,v)
        return b.getvalue()
    def reject(self,data):
        with self.assertRaises(p.PackageError):p.import_package(data,self.dest)
        self.assertFalse(self.dest.exists(),'Invalid package wrote a destination')
    def test_roundtrip_real_png_draft_separate_and_original_workflow_unchanged(self):
        original=copy.deepcopy(self.workflow);r=p.import_package(self.bundle,self.dest);self.assertEqual(self.workflow,original)
        n=next(n for n in r['workflow']['nodes'] if n['type']=='Character3DEditor');self.assertNotEqual(n['widgets_values'][0],self.character['widgets_values'][0]);self.assertEqual((self.dest/n['widgets_values'][0]).read_bytes(),self.png)
        expected=copy.deepcopy(original);next(n for n in expected['nodes'] if n['type']=='Character3DEditor')['widgets_values'][0]=n['widgets_values'][0]
        next(x for x in expected['nodes'] if x['type']=='Character3DEditor')['widgets_values_named']['snapshot']=n['widgets_values'][0]
        self.assertEqual(r['workflow'],expected);self.assertEqual(n['properties']['character3DDraft']['sex'],1);self.assertEqual(json.loads(n['widgets_values'][1])['state']['sex'],0)
    def test_deterministic_export(self):self.assertEqual(self.bundle,p.export_package(self.workflow,SOURCE))
    def test_repeated_import_does_not_overwrite(self):
        a=p.import_package(self.bundle,self.dest);before={f:f.read_bytes() for f in (self.dest/'character_3d').iterdir()};b=p.import_package(self.bundle,self.dest);self.assertTrue(set(a['created_snapshots']).isdisjoint(b['created_snapshots']))
        for f,raw in before.items():self.assertEqual(f.read_bytes(),raw)
    def test_forced_uuid_collision_does_not_overwrite(self):
        self.dest.mkdir();d=self.dest/'character_3d';d.mkdir();old=d/('c3d_'+'0'*32+'.png');old.write_bytes(b'OTHER USER DATA')
        with mock.patch.object(p.uuid,'uuid4',side_effect=[type('ID',(),{'hex':'0'*32})(),type('ID',(),{'hex':'1'*32})()]):r=p.import_package(self.bundle,self.dest)
        self.assertEqual(old.read_bytes(),b'OTHER USER DATA');self.assertEqual(r['created_snapshots'],['character_3d/c3d_'+'1'*32+'.png'])
    def test_deduplicate_shared_png(self):
        w=copy.deepcopy(self.workflow);n=copy.deepcopy(self.character);n['id']=50;w['nodes'].append(n);r=p.import_package(p.export_package(w,SOURCE),self.dest);self.assertEqual(r['characters'],2);self.assertEqual(len(r['created_snapshots']),1)
    def test_unfrozen_draft_is_portable_without_fake_png(self):
        w=copy.deepcopy(self.workflow);n=next(n for n in w['nodes'] if n['type']=='Character3DEditor');n['widgets_values'][:2]=['',''];n.pop('widgets_values_named');r=p.import_package(p.export_package(w,SOURCE),self.dest);self.assertEqual(r['created_snapshots'],[]);self.assertEqual(next(n for n in r['workflow']['nodes'] if n['type']=='Character3DEditor')['properties'],n['properties'])
    def test_sha_mismatch(self):
        f=self.unpack();key=next(k for k in f if k.startswith('images/'));f[key]=f[key]+b'x';self.reject(self.repack(f))
    def test_png_pin_mismatch_even_after_manifest_rehash(self):
        f=self.unpack();key=next(k for k in f if k.startswith('images/'));f[key]=f[key]+b'x';self.reject(self.repack(f,True))
    def test_draft_record_tamper_even_after_manifest_rehash(self):
        f=self.unpack();s=json.loads(f['states/0000.json']);s['draft']['sex']=0;f['states/0000.json']=p.encode(s);self.reject(self.repack(f,True))
    def test_incompatible_renderer_assets(self):
        f=self.unpack();m=json.loads(f['manifest.json']);m['requirements']['files']['assets/human.json']='0'*64;f['manifest.json']=p.encode(m);self.reject(self.repack(f))
    def test_incompatible_state_schema(self):
        f=self.unpack();m=json.loads(f['manifest.json']);m['requirements']['state_schema']='unknown/9';f['manifest.json']=p.encode(m);self.reject(self.repack(f))
    def test_compatible_version_note_requires_exact_fingerprint(self):
        f=self.unpack();m=json.loads(f['manifest.json']);m['requirements']['editor_version']='0.1.0';f['manifest.json']=p.encode(m);r=p.import_package(self.repack(f),self.dest);self.assertIn('fingerprint matches',r['version_note'])
    def test_traversal_and_absolute_and_windows_alias_paths(self):
        for path in ('../evil','/abs.png','C:/evil.png','images\\evil.png','manifest.json:stream','./manifest.json','states/../manifest.json','IMAGES/'+'0'*64+'.png'):
            with self.subTest(path=path):f=self.unpack();f[path]=b'bad';self.reject(self.repack(f,True))
    def test_unlisted_payload(self):
        f=self.unpack();f['images/'+'0'*64+'.png']=self.png;self.reject(self.repack(f))
    def test_reindexed_unreferenced_payload(self):
        f=self.unpack();f['images/'+'0'*64+'.png']=self.png;self.reject(self.repack(f,True))
    def test_duplicate_zip_entry(self):
        b=io.BytesIO(self.bundle)
        with zipfile.ZipFile(b,'a') as z:z.writestr('workflow.json',b'{}')
        self.reject(b.getvalue())
    def test_symlink_zip_entry(self):
        f=self.unpack();b=io.BytesIO()
        with zipfile.ZipFile(b,'w') as z:
            for k,v in f.items():
                i=zipfile.ZipInfo(k);i.external_attr=((stat.S_IFLNK|0o777) if k=='workflow.json' else (stat.S_IFREG|0o600))<<16;z.writestr(i,v)
        self.reject(b.getvalue())
    def test_encrypted_unsupported_compression_and_special_file_rejected(self):
        import struct
        with zipfile.ZipFile(io.BytesIO(self.bundle)) as z:offset=z.start_dir
        for field,value,fmt in ((8,1,'<H'),(10,12,'<H'),(38,(stat.S_IFIFO|0o600)<<16,'<I')):
            with self.subTest(field=field):
                data=bytearray(self.bundle);struct.pack_into(fmt,data,offset+field,value);self.reject(bytes(data))
    def test_duplicate_json_key(self):
        f=self.unpack();f['workflow.json']=b'{"nodes":[],"nodes":[]}';self.reject(self.repack(f,True))
    def test_json_pollution_and_nonfinite_and_deep(self):
        for raw in (b'{"__proto__":{}}',b'{"x":NaN}',b'{"x":1e400}',b'['*40+b'0'+b']'*40):
            with self.subTest(raw=raw):f=self.unpack();f['workflow.json']=raw;self.reject(self.repack(f,True))
    def test_named_widget_mismatch_rejected(self):
        w=copy.deepcopy(self.workflow);next(n for n in w['nodes'] if n['type']=='Character3DEditor')['widgets_values_named']['snapshot']='wrong'
        with self.assertRaisesRegex(p.PackageError,'Named/positional'):p.export_package(w,SOURCE)
    def test_dynamic_linked_input_rejected(self):
        w=copy.deepcopy(self.workflow);next(n for n in w['nodes'] if n['type']=='Character3DEditor')['inputs'][0]['link']=1
        with self.assertRaisesRegex(p.PackageError,'Linked/dynamic'):p.export_package(w,SOURCE)
    def test_bad_or_missing_source_png_rejected(self):
        w=copy.deepcopy(self.workflow);n=next(n for n in w['nodes'] if n['type']=='Character3DEditor');n.pop('widgets_values_named');n['widgets_values'][0]='character_3d/c3d_'+'0'*32+'.png'
        with self.assertRaisesRegex(p.PackageError,'Missing file'):p.export_package(w,SOURCE)
    def test_export_budget_stops_before_png_decode_or_asset_reads(self):
        state=p.characters(self.workflow)[0][1];limit=len(p.encode(self.workflow))+len(p.encode(state))+len(self.png)-1
        with mock.patch.object(p,'MAX_TOTAL',limit),mock.patch.object(p,'validate_png') as decode_png,mock.patch.object(p,'requirements') as read_assets:
            with self.assertRaisesRegex(p.PackageError,'total size'):p.export_package(self.workflow,SOURCE)
        decode_png.assert_not_called();read_assets.assert_not_called()
    def test_zip_bomb_limit_small_fixture(self):
        with mock.patch.object(p,'MAX_WORKFLOW',8):self.reject(self.bundle)
    def test_zip_entry_count_limit(self):
        f=self.unpack();f.update({f'states/{i:04d}.json':b'{}' for i in range(601)});self.reject(self.repack(f))
    def test_invalid_zip(self):self.reject(b'not a zip')
    def test_existing_workflow_output_is_not_overwritten(self):
        out=Path(self.temp.name)/'workflow.json';out.write_bytes(b'KEEP')
        with self.assertRaises(FileExistsError):p.write_new(out,b'REPLACE')
        self.assertEqual(out.read_bytes(),b'KEEP')
    def test_record_boolean_is_not_numeric_node_id(self):
        f=self.unpack();m=json.loads(f['manifest.json']);m['characters'][0]['node_id']=True;f['manifest.json']=p.encode(m);self.reject(self.repack(f))
    def test_record_boolean_is_not_numeric_draft(self):
        f=self.unpack();s=json.loads(f['states/0000.json']);s['draft']['sex']=True;f['states/0000.json']=p.encode(s);self.reject(self.repack(f,True))
    def test_atomic_output_readback_and_staging_cleanup(self):
        out=Path(self.temp.name)/'output.zip';p.write_new(out,b'COMPLETE');self.assertEqual(out.read_bytes(),b'COMPLETE');self.assertEqual(list(out.parent.iterdir()),[out])
    def test_atomic_output_disk_failure_publishes_nothing(self):
        out=Path(self.temp.name)/'output.zip'
        with mock.patch.object(p.os,'fsync',side_effect=OSError('injected disk error')):
            with self.assertRaises(OSError):p.write_new(out,b'PARTIAL')
        self.assertEqual(list(out.parent.iterdir()),[])
    def test_atomic_output_race_preserves_existing_file(self):
        out=Path(self.temp.name)/'output.zip'
        def collision(src,dst):Path(dst).write_bytes(b'OTHER USER DATA');raise FileExistsError(str(dst))
        with mock.patch.object(p.os,'link',side_effect=collision):
            with self.assertRaises(FileExistsError):p.write_new(out,b'REPLACE')
        self.assertEqual(out.read_bytes(),b'OTHER USER DATA');self.assertEqual(list(out.parent.iterdir()),[out])
    def test_atomic_output_unsupported_filesystem_fails_closed(self):
        out=Path(self.temp.name)/'output.zip'
        with mock.patch.object(p.os,'link',side_effect=OSError('hardlinks unsupported')):
            with self.assertRaises(OSError):p.write_new(out,b'COMPLETE')
        self.assertFalse(out.exists());self.assertEqual(list(out.parent.iterdir()),[])
    def test_reserved_output_names_rejected(self):
        for name in ('CON.zip','AUX','output.zip:stream','output.zip.','output.zip '):
            with self.subTest(name=name),self.assertRaises(p.PackageError):p.write_new(Path(self.temp.name)/name,b'NO')
        self.assertEqual(list(Path(self.temp.name).iterdir()),[])
    def test_destination_junction_refused(self):
        # Windows user lacks symlink permission. Test real NTFS directory junction instead.
        if os.name!='nt':self.skipTest('Windows junction probe')
        import subprocess
        outside=Path(self.temp.name)/'outside';outside.mkdir();self.dest.mkdir();link=self.dest/'character_3d'
        subprocess.run(['cmd.exe','/c','mklink','/J',str(link),str(outside)],check=True,capture_output=True)
        try:
            with self.assertRaises(p.PackageError):p.import_package(self.bundle,self.dest)
            self.assertEqual(list(outside.iterdir()),[])
        finally:link.rmdir()
if __name__=='__main__':unittest.main(verbosity=2)
