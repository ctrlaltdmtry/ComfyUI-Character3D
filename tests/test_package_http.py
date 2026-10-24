"""Real CPU aiohttp requests for package transport; folder_paths is an isolated test binding."""
import importlib.util,io,json,sys,tempfile,types,unittest,zipfile
from pathlib import Path
from unittest import mock
from aiohttp import web
from aiohttp.test_utils import TestClient,TestServer
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));import portable_package as p
SCRATCH=Path.home()/'AppData/Local/hermes/cache/scratch';SOURCE=SCRATCH/'character3d-comfy-test/input'
FOLDER=types.ModuleType('folder_paths');FOLDER.get_input_directory=lambda:str(SOURCE)
with mock.patch.dict(sys.modules,{'folder_paths':FOLDER}):
    spec=importlib.util.spec_from_file_location('package_http_test',ROOT/'package_routes.py');routes=importlib.util.module_from_spec(spec);spec.loader.exec_module(routes)
class PackageHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='c3d-package-http-',dir=SCRATCH);self.addCleanup(self.temp.cleanup);self.dest=Path(self.temp.name)/'input'
        FOLDER.get_input_directory=lambda:str(SOURCE);table=web.RouteTableDef();self.assertTrue(routes.register_package_routes(table));self.assertTrue(routes.register_package_routes(table));self.assertEqual(len(table),2)
        app=web.Application();app.add_routes(table);self.client=TestClient(TestServer(app));await self.client.start_server();self.addAsyncCleanup(self.client.close)
        self.workflow=json.loads((ROOT/'examples/character3d-frozen-workflow.json').read_text(encoding='utf-8'))
        from frozen_fixture import stage_frozen_fixture
        self.source=Path(self.temp.name)/'source-input'
        stage_frozen_fixture(self.source,self.workflow)
        FOLDER.get_input_directory=lambda:str(self.source)
    async def exported(self):
        r=await self.client.post('/character3d/package/export',data=p.encode(self.workflow),headers={'Content-Type':'application/json'});self.assertEqual(r.status,200);self.assertEqual(r.headers['Content-Type'],'application/zip');data=await r.read();p.inspect_package(data);return data
    async def test_export_import_real_request_and_disk_readback(self):
        data=await self.exported();FOLDER.get_input_directory=lambda:str(self.dest);r=await self.client.post('/character3d/package/import',data=data,headers={'Content-Type':'application/zip'});self.assertEqual(r.status,200);out=await r.json();self.assertEqual(out['characters'],1)
        n=next(n for n in out['workflow']['nodes'] if n['type']=='Character3DEditor');self.assertEqual(p.digest((self.dest/n['widgets_values'][0]).read_bytes()),json.loads(n['widgets_values'][1])['png_sha256']);self.assertEqual(n['properties']['character3DDraft']['sex'],1)
    async def test_invalid_import_writes_nothing(self):
        FOLDER.get_input_directory=lambda:str(self.dest);r=await self.client.post('/character3d/package/import',data=b'not zip');self.assertEqual(r.status,400);self.assertIn('error',await r.json());self.assertFalse(self.dest.exists())
    async def test_cross_origin_write_refused(self):
        FOLDER.get_input_directory=lambda:str(self.dest);r=await self.client.post('/character3d/package/import',data=b'not zip',headers={'Origin':'https://untrusted.example'});self.assertEqual(r.status,403);self.assertFalse(self.dest.exists())
    async def test_oversized_declared_request_rejected(self):
        with mock.patch.object(p,'MAX_ARCHIVE',4):
            r=await self.client.post('/character3d/package/import',data=b'12345');self.assertEqual(r.status,413)
    async def test_missing_export_png_returns_actionable_failure(self):
        FOLDER.get_input_directory=lambda:str(self.dest);r=await self.client.post('/character3d/package/export',data=p.encode(self.workflow));self.assertEqual(r.status,400);self.assertIn('error',await r.json())
    async def test_package_routes_not_public_file_endpoints(self):
        r=await self.client.get('/character3d/package/import');self.assertEqual(r.status,405)
if __name__=='__main__':unittest.main(verbosity=2)
