"""Stage the durable, genuinely rendered sample for CPU tests, never invent/re-render it."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def stage_frozen_fixture(input_directory,workflow):
    node=next(n for n in workflow['nodes'] if n['type']=='Character3DEditor')
    expected=json.loads(node['widgets_values'][1])['png_sha256']
    raw=(ROOT/'examples/character3d-sample.png').read_bytes()
    if hashlib.sha256(raw).hexdigest()!=expected:
        raise AssertionError('Durable genuine PNG does not match saved workflow; no replacement is allowed')
    path=Path(input_directory)/node['widgets_values'][0]
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        if path.read_bytes()!=raw:raise AssertionError('Existing fixture differs; refusing to overwrite it')
    else:
        with path.open('xb') as stream:stream.write(raw)
    return raw
