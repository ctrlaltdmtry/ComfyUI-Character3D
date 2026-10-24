# SPDX-License-Identifier: MIT
"""Explicit CPU-only export/import/inspect of a portable .character3d.zip package."""
import argparse,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from portable_package import export_package,import_package,inspect_package,read_limited,decode,encode,write_new,MAX_ARCHIVE,MAX_WORKFLOW

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--runtime',type=Path,default=ROOT,help='Runtime whose renderer/assets are checked (default: this package)');sub=p.add_subparsers(dest='operation',required=True)
    e=sub.add_parser('export');e.add_argument('workflow',type=Path);e.add_argument('output',type=Path);e.add_argument('--input-dir',required=True,type=Path)
    i=sub.add_parser('import');i.add_argument('package',type=Path);i.add_argument('--input-dir',required=True,type=Path);i.add_argument('--workflow-out',required=True,type=Path)
    s=sub.add_parser('inspect');s.add_argument('package',type=Path)
    a=p.parse_args(argv)
    try:
        if a.operation=='export':
            data=export_package(decode(read_limited(a.workflow,MAX_WORKFLOW),MAX_WORKFLOW),a.input_dir,a.runtime);write_new(a.output,data);print(json.dumps({'package':str(a.output.absolute()),'bytes':len(data),'verified':True},ensure_ascii=False))
        else:
            data=read_limited(a.package,MAX_ARCHIVE)
            if a.operation=='inspect':
                checked=inspect_package(data,a.runtime);print(json.dumps({'schema':checked['manifest']['schema'],'characters':len(checked['characters']),'requirements':checked['manifest']['requirements'],'external_node_types':checked['manifest']['external_node_types'],'version_note':checked['version_note'],'files_checked':len(checked['files']),'verified':True},ensure_ascii=False,indent=2))
            else:
                # Refuse existing/symlinked workflow target BEFORE importing snapshots.
                out=a.workflow_out.absolute()
                if out.exists() or out.is_symlink() or out.resolve()!=out or not out.parent.is_dir():raise ValueError('Workflow output must be a new file in an existing, non-symlinked directory')
                result=import_package(data,a.input_dir,a.runtime);write_new(out,encode(result.pop('workflow')));result['workflow']=str(out);result['verified']=True;print(json.dumps(result,ensure_ascii=False))
    except (ValueError,OSError,UnicodeError,TypeError) as exc:p.exit(1,'Character3D package: '+str(exc)+'\n')
    return 0
if __name__=='__main__':raise SystemExit(main())
