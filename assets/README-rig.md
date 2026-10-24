# CC0 MakeHuman game-engine rig for `human.json`

`rig.json` is generated from the pinned, genuine MPFB **game_engine** skeleton and authored weights, not a heuristic skin or inferred anatomy. It has **53 bones**, including **30 finger bones**, four influence slots per body/eye vertex, female/male fitted bind landmarks, and all six body-morph IDs. Source and output hashes are in `rig.manifest.json`.

## Files / reproduction

```text
python -B tools/prepare_rig.py --offline
node tools/validate_rig.mjs
```

Without `--offline`, the converter can download the two pinned CC0 JSON files if missing. It requires the already-prepared human source assets. It does not run `prepare_human.run`, modify the mesh/manifest/viewer, install packages, or need Blender. `prepare_human` is safely imported only for its existing original format/math helpers; upstream GPL code is neither imported nor vendored.

- `rig-sources/rig.game_engine.json`, `rig-sources/weights.game_engine.json`: upstream CC0 rig assets, pinned SHA256 enforced in the converter.
- `rig.json`: runtime data, 501,589 bytes.
- `rig.manifest.json`: provenance, input hashes, actual landmark strategies and joint-group vertex IDs.
- `rig.validation.json`: full numeric skin/landmark checks and influence reduction.
- `rig.three-validation.json`: real Three.js r180 CPU bind/pose checks.
- `../tools/prepare_rig.py`, `../tools/validate_rig.mjs`: reproducible conversion and tests.

## Contract

All arrays use `human.json`'s exact body vertex order, and the exact seam-duplicated eye vertex order. `skinIndex`, `skinWeight`, `eyeSkinIndex`, `eyeSkinWeight` are **flat arrays**, length `4 * vertexCount`, suitable directly for itemSize-4 attributes. Unused slots contain index 0 and weight 0; only positive-weight influences must be unique.

`bones` is parent-before-child:

```js
{ name, parent, head, tail, maleHead, maleTail }
```

`parent` is a bone index, or -1 for `Root`. Head/tail coordinates are **absolute original OBJ coordinates**, +Y up, +Z forward, decimetres. They are calculated from full macro-deformed basemesh helpers, not from upstream `default_position` (which is in a different coordinate basis/scale). Each `CUBE` landmark averages unique vertices in its genuine `joint-*` OBJ group. The root tail uses the upstream explicit `MEAN` vertex references.

All bone rest orientations are intentionally identity; do **not** aim local Y at `tail`, use `lookAt`, apply upstream roll, rotate the skeleton to Z-up, or offset the body independently. Head positions supply the actual rotation pivots. Rest axes coincide with **model** XYZ; under a posed parent, child local axes inherit the parent's rotation normally. This does not promise global-axis rotation throughout an articulated pose.

`morphs` contains `{id, delta, maleDelta, tailDelta, maleTailDelta}`, each delta array length `3 * boneCount`. Blend heads using the same equation as body geometry:

```js
head[j] = (1-g)*femaleHead[j] + g*maleHead[j];
head[j] += morphWeight[id] * ((1-g)*m.delta[j] + g*m.maleDelta[j]);
```

Tail deltas are optional display/debug information, not needed for skinning. **All six currently supplied morphs have zero joint-head deltas** in both sexes: those authentic detail/physique targets do not move the rig's chosen helper landmarks. This was evaluated, not replaced with guessed offsets. Female/male base joint positions do differ. Geometry muscle/weight limits remain those in `README-human.md`.

## Renderer setup and shape changes

1. Create body and eye `THREE.SkinnedMesh` objects, preserving geometry, indices, materials and morph calculations. Add `Uint16BufferAttribute(rig.skinIndex, 4)` and `Float32BufferAttribute(rig.skinWeight, 4)` to the body; use the corresponding eye arrays for the eyes.
2. Make a `THREE.Bone` per entry. For every bone set quaternion identity, scale 1, and local position `absoluteHead - parentAbsoluteHead` (root uses its absolute head). Parent bones according to `parent`. `Root` has zero direct vertex weights by design; it controls descendants.
3. One reliable layout is a common model group holding both skinned meshes; add the root bone to the body mesh. Body and eyes have identity mesh transforms. Keep centering/scaling on their shared model group.
4. Update all world matrices in **zero-rotation rest pose**. Create/share one `THREE.Skeleton(bones)`. Calculate inverses and bind both meshes in that same pose. `tools/validate_rig.mjs` is an executable minimal example with this exact layout.
5. Apply user rotations only after binding, then update world matrices and skeleton before rendering. No continuous animation loop is necessary; request a render after pose/shape changes.
6. For sex or geometry morph changes: preserve intended pose angles; reset bone rotations; update both meshes' pre-skin positions and compute normals; refit absolute bone heads; assign local parent-relative positions; update world matrices; recalculate inverses and rebind body/eyes; then restore intended pose. **Never calculate inverses while bones are posed**, which would absorb the pose into the rest state. Do not accidentally use the female inverse bind matrices with male joint positions.
7. Recompute skinned bounds after pose changes, or initially use `frustumCulled=false`, to avoid stale geometry bounds clipping articulated limbs.

Useful exact bone names: `Root`, `pelvis`, `spine_01`, `spine_02`, `spine_03`, `neck_01`, `head`; paired `clavicle_l/r`, `upperarm_l/r`, `lowerarm_l/r`, `hand_l/r`, `thigh_l/r`, `calf_l/r`, `foot_l/r`, `ball_l/r`; `thumb_01_l` through `thumb_03_l`, and `index`, `middle`, `ring`, `pinky` equivalents on both sides. Resolve indices by name rather than assuming numeric values.

## Verification and limitations

- 13,380 body vertices and 1,076 eye vertices: finite values, valid indices, zero unbound vertices, zero duplicate positive influences; maximum stored weight-sum error `1.11e-16`.
- All 52 non-root bones actually affect body vertices. Both female/male body and eye reconstructions exactly match the existing serialized mesh endpoints before rig export.
- Strongest-four conversion affects 608 body vertices. Maximum discarded original normalized weight is **0.0335999981** (about 3.36%); mean over all body vertices is **0.0001885267**. Remaining weights are normalized. Original files remain available for higher-influence renderers.
- Eye weights are transferred from original full-basemesh weights using the actual MHCLO references, preserving UV seam order. MHCLO fitting permits small negative barycentric coefficients; the resulting transferred skin weights were checked nonnegative. In this rig all eye references are authored 100% to `head`.
- There are no independent eye, jaw or facial bones in the upstream game-engine rig. Do not imply eye tracking or facial skeletal animation support. Facial geometry sliders still work.
- No upstream bone-local animation compatibility is implied: this export intentionally changes rest orientation to identity as requested. Imported animations would need rest-basis retargeting.
- Actual vendored Three.js r180 tested 24 zero-pose gender/morph scenarios (maximum body error `3.27e-7`) and 10 articulated joint cases, including head/eyes, elbows, knees, fingers, and root rigid rotation. Output is in `rig.three-validation.json`.
- Offline repeated conversion gives byte-identical output. Numeric/CPU tests are not GPU/visual pose-quality certification; renderer integration and visual inspection remain the parent's work.
