# Character / 3D Editor for ComfyUI

[English](README.md) · [Русский](https://github.com/ctrlaltdmtry/ComfyUI-Character3D/blob/main/README.ru.md)

**Version 0.5.1** · Local WebGL2 editor · RU / EN interface · Immutable PNG snapshots

Create and pose adult 3D characters inside ComfyUI, then freeze the rendered composition into an `IMAGE` and foreground `MASK`. The editor uses bundled MakeHuman/MPFB graphical assets and Three.js; using it does not require Blender, a diffusion model, a CDN or an external API.

## Features

- One to four independent characters in a shared scene: add, duplicate, rename, place and hide actors; edit the selected actor without changing the others.
- 68 identity controls for face and body, with search, precise values, resets and draggable shape handles. Authored adult male/female endpoints.
- Body and facial posing: rotation gizmos, FK, four-limb two-bone IK, independent gaze, expressions and face-only reset.
- Separate output and inspection cameras; configurable canvas, background and transparency.
- Configurable character sheets: up to 4 × 4 cells, independent cell cameras and optional captions. Identity and pose are shared between cells.
- Sticky section tiles: click for one section, Shift+click to toggle several, and open/close-all controls.
- RU / EN switches text in place. Russian is the initial default; the device remembers the choice. Changing language does not change scene values, authored names, captions or frozen snapshots.
- Explicit **Freeze** captures an immutable PNG. Draft edits do not invalidate or redraw an earlier frozen result.
- Portable `.character3d.zip` packages preserve workflow, editable drafts and exact frozen PNGs, with renderer/asset fingerprint validation.
- On-demand rendering rather than a continuous idle animation loop.

## Installation

From your ComfyUI `custom_nodes` directory:

```bash
git clone https://github.com/ctrlaltdmtry/ComfyUI-Character3D.git
```

Start or restart ComfyUI yourself after installation. The package never launches or restarts the server. If the old frontend remains cached, refresh the browser with Ctrl+F5.

Alternatively, from a separate checkout:

```bash
python tools/install_node.py /path/to/ComfyUI/custom_nodes --dry-run
python tools/install_node.py /path/to/ComfyUI/custom_nodes
```

An existing target requires explicit `--update`; back it up first. The installer copies only its runtime whitelist, verifies SHA256 and does not update dependencies or other nodes. It does not remove non-runtime files.

Requirements: ComfyUI with Python 3.10+, NumPy, Pillow, PyTorch and aiohttp, plus a WebGL2-capable browser. These Python libraries are normally already present in ComfyUI. Do not install a separate PyTorch build over ComfyUI's environment just for this node.

## First use

1. Add **Character / 3D Editor** from **Character/3D**, or open the starter workflow in `examples/character3d-workflow.json`.
2. Open **Editor / Редактор** and adjust the character, pose and cameras.
3. Click the editor's **Freeze → node / Freeze → нода** control and wait for completion.
4. Connect `image` to SaveImage or another image input, then queue the workflow.

| Output | Meaning |
| --- | --- |
| `image` | Frozen float32 RGB tensor `[B,H,W,C]`, values in `[0,1]` |
| `foreground_mask` | Float32 foreground-alpha coverage `[B,H,W]`; foreground = 1 |
| `scene_json` | Validated frozen envelope |
| `description` | Optional description |

The mask is **not** LoadImage's inverted alpha mask. For nontrivial coverage, enable transparent output before Freeze; an opaque background gives an all-one mask. Sheet captions contribute to both PNG alpha and the foreground mask. SaveImage receives RGB; keep the mask separately or export the PNG to retain transparency.

The editor's PNG export captures the current draft; the node's PNG export returns the last frozen image. Ordinary workflow JSON does not embed its frozen PNG: use a portable Character3D package to transfer both together, or transfer the matching input PNG separately. Save your current graph before confirming package import; import replaces the workflow and does not queue it.

## Portable packages

The node's package export/import controls handle Character3D data without rendering a new image. A CPU-only CLI is also available:

```bash
python -B tools/character_package.py export workflow.json scene.character3d.zip --input-dir /path/to/source/input
python -B tools/character_package.py inspect scene.character3d.zip
python -B tools/character_package.py import scene.character3d.zip --input-dir /path/to/receiver/input --workflow-out restored.json
```

Use new output filenames. Editable packages require matching rendering-code and asset fingerprints, not merely the same version label. Version-only differences can be accepted with a notice when fingerprints match. Old immutable PNGs remain replayable, but this does not make all older editable packages compatible.

Packages do not bundle arbitrary ComfyUI nodes, model weights or other extensions' file inputs. SHA256 detects corruption and inconsistent data, not the author's identity: load workflows only from trusted sources.

## Standalone preview

From this repository's root:

```bash
python -m http.server 8767 --bind 127.0.0.1
```

Open <http://127.0.0.1:8767/>. The standalone editor can export PNGs; sending Freeze results to a node requires the ComfyUI integration. Assets and rendering stay local, but the containing ComfyUI server may have its own network configuration.

## Limits

This is a low-poly parametric editor, not a sculpting application or a finished digital-human system. Face/body editing needs further expansion. Hairstyles, detailed skin textures, additional anatomical attachments, clothing systems, Mixamo retargeting, per-actor masks and independent per-sheet-cell poses are not implemented.

IK uses an analytic two-bone solver and scalar angle limits, not biomechanical or collision constraints. Extreme morphs, facial poses and free-mode extrapolation can intersect or distort; technical acceptance is not artistic approval. Real weak-GPU/phone performance and universal leak-free behavior are not certified.

During development, 0.5.1 underwent JavaScript/Python regressions, actual RU/EN CPU/SwiftShader browser scenarios, Freeze/Save readback and exact CPU IMAGE/MASK and portable-relocation checks. Those are bounded development results, not a guarantee for every ComfyUI/frontend version or device. Machine-local QA credentials, raw run logs, deployment scripts and installation receipts are intentionally not published.

## Development tests

Run from the repository root with a modern Node.js supporting `node:module.registerHooks` (development acceptance used Node 26) and the Python dependencies listed above:

```bash
node --experimental-vm-modules --import ./tests/register-three-alias.mjs --test tests/*.test.mjs
python -B -m unittest discover -s tests -p 'test_*.py'
```

The Node hook maps Three.js imports to the bundled version; no npm install is required. Python parity tests also need Node on PATH, and HTTP fixtures need permission to bind temporary loopback ports. These are unit/contract and local-HTTP checks, not a live ComfyUI/native-browser run. Some inherited test fixtures use a generic `~/AppData/Local/hermes/cache/scratch` location for isolated temporary inputs; this is a test-directory convention, not a requirement to install Hermes. Generated reports under `tests/performance/` are ignored by Git.

Asset READMEs retain historical authoring and validation notes. This lean publication does not include the complete asset-authoring source caches, regeneration programs, native-browser acceptance harnesses or machine-specific release/deployment tools. Tests for those excluded tools are not included; their historical full-suite totals must not be attributed to this public subset.

## Licenses and provenance

- Project code: [MIT](LICENSE).
- Prepared MakeHuman/MPFB meshes, targets, rig/skin data and associated graphical assets: [CC0 1.0](assets/LICENSE.ASSETS.md). See the asset manifests and `assets/README-*.md` for provenance and fitting limitations.
- Bundled Three.js and controls: [upstream MIT notice](vendor/THREE-LICENSE.txt).

No Mixamo assets are redistributed. GPL-licensed authoring program sources are not bundled as runtime dependencies.
