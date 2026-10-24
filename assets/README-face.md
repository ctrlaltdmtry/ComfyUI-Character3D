# Authentic CC0 facial extension

## Artifacts / rebuild

```text
python -B tools/prepare_face.py --offline --test
```

No Blender, package installation, ComfyUI restart, generated anatomy, sphere eyes, or imported upstream GPL code. The converter imports only this project's original `prepare_human` / `prepare_rig` format helpers. It never calls their `run` functions or changes their outputs. Online mode recovers missing SHA-pinned sources; selected system-pack members use HTTP range reads rather than downloading the entire 280,737,770-byte archive.

- `face-rig.json`: complete runtime rig, **112 bones = original 53 + 59 authored default facial descendants**.
- `face-morphs.json`: `{morphs:[...]}`, 14 genuine expression channels, flat body `delta` arrays of **40,140 numbers** in the exact existing 13,380-vertex order.
- `face-parts.json`: `{parts:[...]}`, fitted upper teeth, lower teeth, connecting gum strip, tongue. All are separate genuine meshes sharing the complete skeleton.
- `face.manifest.json`: pinned URLs/member names, SHA256, input/output hashes, exact authored landmark specifications, joint-helper vertex IDs and parent mapping.
- `face.validation.json`: finite/topology/skin checks, mask indices and four-influence losses.
- `face.three-validation.json`: real vendored **Three.js r180 CPU** bind, pose, independent eye, jaw, translation and frontal ray-occlusion tests.
- `face-sources/`: intact `rig.default.json`, `weights.default.json`, selected targets and CC0 OBJ/MHCLO files; `sources.json` is itself hash-pinned in the converter.

`human.json`, `rig.json`, both base manifests and compact vertex map remain unchanged and their hashes are checked. Viewer/controller files are outside this task and were not modified.

## Sources and graft, not rig replacement

MPFB master resolved to `afb9f530a7c2741dedb8df0ebae2e0b183caec21`, the same pinned revision as the existing adult body. Its default rig has 163 bones. Only its **59 descendants below `head`** are appended: jaw, independent eyes, muscle-like facial chains and tongue chains. Existing game-engine bone names, indices, heads, tails, male endpoints and parent hierarchy remain exactly unchanged. All facial source parents already belong to this subtree or are the existing `head`; no anatomical parent guesses or body-name translation table are needed.

The original default source files are not edited. CUBE landmarks average the original joint group's unique vertices; VERTEX uses its exact authored vertex; MEAN uses its exact authored IDs. All are evaluated on full female/male macro-deformed basemeshes before compact rendering. Default Blender-oriented positions/roll are deliberately ignored, as in the existing identity-rest export.

**The default face weights spill into neck/body transition rows. They must not be copied wholesale.** A compact body row is replaced only when all three conditions hold:

1. Its original default row has a positive facial descendant weight.
2. Its existing game-engine row is exactly 100% `head`.
3. Its default row contains only `head` and its facial descendants.

This leaves **10,789 body rows byte-for-byte unchanged**, including every neck/body mixed row; **2,591 facial rows** use their actual default authored weights. **401 candidate transition rows** are intentionally excluded. No nearest-bone, spatial height cutoff, falloff, or guessed weights are used.

Strongest-four normalization is required by the existing renderer contract. It discards influences in 575 facial rows; maximum discarded original normalized mass is **0.2998299784**, mean across changed facial rows **0.0107908082**. This is a real limitation of four-slot facial skinning, not a lossless export. Full authored weights remain in the source directory. No vertex is unbound.

The proposed `makehumancommunity/makehuman-assets` repository returned 404. Teeth/tongue instead come from the official `makehuman_system_assets_cc0.zip` at the manifest's files2 URL. Every selected OBJ/MHCLO explicitly declares its September 2020 CC0 release. An older third-party mirror's files declared AGPL and were **rejected**, not included. The cheek target is from official `functional/faceunits01.zip`; its included metadata explicitly declares `cheekPuff` CC0, author Mika Suominen. No child/baby assets were acquired.

## Rig/runtime contract

The base `README-rig.md` contract still applies: flat four-slot skin arrays, absolute heads/tails, parent-before-child, +Y up, +Z forward, decimetres, identity rest orientations.

```js
rig.controls.jaw === 'jaw';
rig.controls.eyes; // ['eye.L', 'eye.R']
rig.faceBones;     // all 59 appended bone names
rig.controls.markers; // semantic marker -> actual authored weighted bone
```

Female authored pivots, not object origins:

- `jaw.head = [0, 6.48575, 0.56295]`, male `[0, 7.89275, 0.64045]`.
- `eye.L.head = [0.2885, 6.7949, 1.11485]`; right is mirrored in X. These come from the genuine `joint-l-eye` / `joint-r-eye` helpers.

Eye seam order exactly matches the existing 1,076 vertices. Each original proxy vertex is assigned rigidly to the unique `eye.L` or `eye.R` owner present in its genuine MHCLO source references: **544 left / 532 right** after UV duplication. It is not a coordinate sign split or inferred eye center. Tiny source lid influences on ocular helper references are deliberately not transferred to the rigid external eyeballs. Rotating one eye does not rotate the other.

**Positive local X jaw rotation opens downward** in this Y-up/Z-front identity rest basis. CPU tests use `+0.3` radians; the suggested conservative UI range is `[0,0.35]`. Sideways yaw can use local Y with suggested `[-0.06,0.06]`. Limits are UI safety recommendations, not authored biomechanical measurements. Eye local forward is +Z; map a world gaze target into the current parent's basis, retaining the authored pivot, rather than aiming local Y at the bone tail.

Facial translation offsets are additive **bone-local XYZ decimetres**, baseline `[0,0,0]`. Set local position to `restParentRelativePosition + state.faceOffsets[name]`; never overwrite rest position with the offset and never calculate bind inverses after adding face offsets. The rest identity axes inherit the posed parent's rotation. Example marker bones tested with a +0.03 local-Y translation: `oculi01.L` (brow), `orbicularis03.L` (upper lid), `oris03.L` (lip corner), `risorius03.L` (cheek). Metadata also supplies their right counterparts, lower lids and center lips.

Each rig morph delta array is extended to `3 * 112 = 336` numbers. The first 159 numbers of the existing six shape morphs are preserved; genuine facial landmark deltas are appended. Expression entries are additionally tagged `expression:true`. They are rest-landmark data, **not another copy of body geometry deltas**. Use the matching face expression strengths if refitting expression-dependent landmarks. Do not append the expression `delta` arrays to body shape sliders as absolute coordinates.

For gender/shape changes, zero all pose quaternions **and face translations**, fit geometry/landmarks, bind all body/eyes/parts to one shared skeleton, then restore the existing body pose and facial state. For a face-only reset, clear expression strengths and restore rotations/offsets only in `faceBones`; do not clear the existing 53-body-bone pose.

## Expression channels

All deltas are actual source offsets, applied before skinning, from zero baseline with strength in `[0,1]`. Male deltas are omitted because these source unit targets have no separate sex variant; the same offsets apply to both authored adult endpoints.

| IDs | Actual source |
| --- | --- |
| `eye_close_l/r` | `eye-left/right-closure` |
| `brow_up_l/r` | `eyebrows-left/right-up` |
| `brow_down_l/r` | `eyebrows-left/right-down` |
| `smile` | `mouth-corner-puller` |
| `frown` | `mouth-depression` |
| `lips_compress` | `mouth-compression` |
| `cheeks` | CC0 `cheekPuff` |
| `smile_l/r`, `frown_l/r` | partition of the corresponding genuine symmetric target |

L/R means anatomical subject side: left is **+X**, right **-X**. Eye/brow source target sides were checked against this convention. Split lip channels retain the source displacement on the chosen original-basemesh X side, zero the opposite side, and assign **half the source displacement to X=0 vertices**. Left+right at equal strength reconstruct the original symmetric target exactly. No mirrored/generated displacement or invented negative opposite is used.

Use **either** the symmetric smile/frown channel **or** its two split channels; adding both doubles the source displacement. Symmetric controls can simply drive both split strengths equally. `frown` is the published mouth-depression unit, not a claim to reproduce a complete emotional expression. Emotion presets are combinations of these channels/face controls; their blending is the UI's responsibility, and extreme opposing combinations are not collision-certified.

## Teeth and tongue

Actual OBJ topology is fitted through the original MHCLO reference vertices, signed coefficients and per-axis offset scales, separately for both adults. No independent centering/scaling.

| Part | Vertices | Triangles | Authored attachment |
| --- | ---: | ---: | --- |
| `teeth_upper` | 1,984 | 3,636 | `head` |
| `teeth_lower` | 1,884 | 3,444 | `jaw` |
| `teeth_gum_bridge` | 44 | 40 | original mixed head/jaw rows |
| `tongue` | 226 | 448 | strongest four of original tongue-chain/helper weights |

The genuine teeth mesh has **20 quads connecting upper and lower gum ownership regions**. These are preserved in `teeth_gum_bridge`, not deleted, reassigned wholesale, or synthesized. Its 44 vertices duplicate existing seam positions across parts; total original polygon/triangle count is preserved. The mouth's back connective tissue can stretch when opened; this is the authored asset, not separate high-detail gums.

Parts contain `{id, positions, male, indices, skinIndex, skinWeight, morphs, material, sourceAsset, sourceVertexIndices}`. `morphs` includes all existing shape IDs and expression IDs, with both sex deltas from actual proxy refitting. Upper/lower teeth rigid ownership comes from MHCLO reference skin weights, not a Y-plane guess. Tongue is authentic authored low-poly geometry, not a synthesized shape. The `material` colors/roughness are explicit preview defaults, **not supplied upstream texture data**; meshes are exported shared-indexed without textures/UVs.

## Verification and remaining limits

Executed `python -B tools/prepare_face.py --offline --test` using existing Three.js r180:

- Finite endpoints/morph arrays, valid topology and indices, normalized skin weights, zero unbound vertices; nondegenerate female/male part meshes and all body expression endpoints.
- **24 rest scenarios** across female/blend/male and existing shape variants; maximum rest skinning error **3.30499e-7** decimetres.
- Nine existing body joint poses compared directly with the original 53-bone rig; maximum pose difference **2.74624e-7** decimetres. Head pose carries both eyeballs and all mouth parts correctly.
- Each independently rotated eye preserves its authored pivot radius and moves only its own 544/532 vertices; opposite-eye movement is **zero**.
- +0.3 X jaw rotation leaves upper teeth unchanged, moves lower teeth and tongue; mean downward displacement of the front 100 lower samples is **-0.195906 female / -0.222553 male** decimetres.
- Brow/lid/lip/cheek local translations move genuinely weighted face vertices, proving nonrotation marker controls work.
- Real frontal CPU ray occlusion was checked at the front 160 vertices of each teeth part. At rest upper teeth are hidden **160/160** for each adult; lower teeth are hidden **156/160 female, 158/160 male**. A few neutral front samples are therefore exposed: do **not** claim perfectly sealed lips. At +0.3 jaw opening the exposed lower samples increase to **88/160 female, 78/160 male**; upper teeth remain behind the upper lip. No artificial inward tooth offset was applied to hide this result.

These numeric/CPU tests are not GPU artistic-quality certification, complete lip/eye collision testing, texture quality validation, or support for native MPFB local animation channels. UI integration and visual QA remain separate. Four-influence reduction, untouched neck transition rows, and native source gum connectors are documented tradeoffs, not invented anatomy.
