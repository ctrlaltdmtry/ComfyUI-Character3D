# SPDX-License-Identifier: MIT
"""CPU-only package transport. Explicit export/import; no workflow execution or rendering."""
import asyncio,json
from pathlib import Path
from aiohttp import web
import folder_paths
if __package__:
    from . import portable_package as package
else:
    import portable_package as package

ROOT=Path(__file__).resolve().parent

def check_origin(request):
    # Match Comfy's host. Drive-by cross-origin imports must not write files.
    origin=request.headers.get('Origin')
    if origin:
        from urllib.parse import urlsplit
        o=urlsplit(origin)
        if o.scheme not in('http','https') or o.netloc!=request.host:raise web.HTTPForbidden(text='Cross-origin package request refused')

async def body(request,limit):
    check_origin(request)
    if request.content_length is not None and request.content_length>limit:raise web.HTTPRequestEntityTooLarge(max_size=limit,actual_size=request.content_length)
    data=bytearray()
    async for chunk in request.content.iter_chunked(65536):
        data.extend(chunk)
        if len(data)>limit:raise web.HTTPRequestEntityTooLarge(max_size=limit,actual_size=len(data))
    return bytes(data)

async def package_export(request):
    raw=await body(request,package.MAX_WORKFLOW)
    try:
        workflow=package.decode(raw,package.MAX_WORKFLOW)
        data=await asyncio.to_thread(package.export_package,workflow,folder_paths.get_input_directory(),ROOT)
        return web.Response(body=data,content_type='application/zip',headers={'Content-Disposition':'attachment; filename="character.character3d.zip"','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'})
    except (ValueError,OSError,TypeError) as exc:return web.json_response({'error':str(exc)},status=400)

async def package_import(request):
    raw=await body(request,package.MAX_ARCHIVE)
    try:
        result=await asyncio.to_thread(package.import_package,raw,folder_paths.get_input_directory(),ROOT)
        return web.json_response(result,headers={'Cache-Control':'no-store'})
    except (ValueError,OSError,TypeError) as exc:return web.json_response({'error':str(exc)},status=400)

def register_package_routes(routes=None):
    if routes is None:
        try:from server import PromptServer
        except ImportError:return False
        if getattr(PromptServer,'instance',None)is None:return False
        routes=PromptServer.instance.routes
    for path,handler in (('/character3d/package/export',package_export),('/character3d/package/import',package_import)):
        if not any(getattr(r,'path',None)==path and getattr(r,'method',None)=='POST' for r in routes):routes.post(path)(handler)
    return True
