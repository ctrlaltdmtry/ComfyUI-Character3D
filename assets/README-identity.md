# Adult identity morphs

`identity.json` adds **62 genuine CC0 identity controls** to the existing six. It does not replace body topology, change adult age, add genital assets, change any skin weights, or treat expression controls as permanent appearance.

## Reproduction

```bash
python -B tools/prepare_identity.py --offline --test
node tests/identity.test.mjs
python -B tests/verify_identity.py
node tests/drag-identity-markers.mjs "$(agent-browser --session character3d get cdp-url)"
```

The offline converter uses the existing pinned full basemesh, MakeHuman MHCLO attachments, game-engine/default landmark specifications and cached target catalog. It imports only this project's original format helpers, not upstream GPL program code. Network acquisition, if needed, retrieves exact asset filenames from the SHA-pinned catalog and verifies Git blob IDs and SHA256. Adult base and full source dependencies are rechecked against earlier manifests.

## Runtime contract

Schema: `character-3d-identity/1`. Controls have stable `identity_*` IDs, Russian labels/endpoint captions, a category, default zero and conservative `min` / `max` values. All 59 bidirectional controls use actual authored opposite targets; a negative value applies `negativeDelta * abs(value)`, never an invented inverse of the positive target. Three one-sided controls narrow nose, mouth and chin, complementing the old widening controls.

- Body/eye/mouth deltas use `{indices, values}`: sorted unique compact vertex IDs, flat XYZ triples. Empty sparse deltas accurately describe unaffected attachments.
- Female `delta` and male `maleDelta` share the exact body topology; negative counterparts are `negativeDelta` and `negativeMaleDelta`. Male channels are explicit in this asset.
- `eyes` contains corresponding deltas in the preserved 1,076-vertex UV-seam order.
- `parts` keys are `teeth_upper`, `teeth_lower`, `teeth_gum_bridge`, `tongue`, preserving existing order and skinning.
- `rig` contains corresponding absolute head-pivot deltas, each length **336**, for all **112** bones. The renderer adds these in rest pose, rebinds, then restores rotations and facial offsets.
- Blend full female/male bases first, then the sex-matched deltas. Preserve old dense arithmetic so existing saved faces and poses do not drift.

## Controls and UI

Categories cover head/forehead/cheeks, eyes/eyelids, nose, mouth/lips, chin/jaw, ears, stature/torso, chest, arms and legs. The editor offers collapsible groups, search, face/body filtering, sliders, numeric inputs, single-control and category resets. Shape reset does not reset pose or expression.

The **Маркеры формы** toggle exposes viewport handles tied to real deformed body vertices. Horizontal/vertical dragging changes two mapped identity controls; selecting a handle opens its category. These are separate from expression handles and do not enter canvas PNGs. Bilateral controls use paired authored left/right targets; they are not independently asymmetric shape editing.

## Natural vs free range

Deltas retain raw authored endpoint strength. Eleven controls have narrower default ranges: head width, eye spacing, outer socket projection, eyelid fold height, epicanthus, mouth height/projection, ear projection/lobe, stature and breast size. Their limits are in the asset and manifest. Individual limited endpoints were screened for body triangles whose normals oppose the baseline; that is a conservative local screen, not full self-intersection certification.

Free mode removes these reduced limits: bidirectional new controls allow **−1.5…+1.5**, one-sided new controls **0…1.5**. This extrapolates source geometry and can produce intersections. It is explicitly not an anatomical safety guarantee.

## Measured validation and limitations

The converter checks **242** sex/direction endpoint cases, exact source remapping, topology, finite values, nondegenerate triangles, all authored landmark strategies, and attachment fitting. Actual Three.js r180 CPU checks exercise 242 rest scenarios and 32 pose cases. Read the JSON reports for exact errors and source hashes.

- Eye-size controls alter the eye opening, not eyeball radius. Outer socket projection may not move the eyeball. Zero helper effects are retained, not guessed.
- The female adult breast-size/firmness macro has explicit zero male deltas; its sliders intentionally have no male effect. Other chest details can affect both bases.
- Height/breast macros are adult average-physique endpoints, not a reconstruction of the full interacting MakeHuman macro grid.
- MHCLO offset scaling uses absolute coordinate differences. Summing independently refitted deltas is not a complete nonlinear combined-target refit; extreme combinations can still misfit attachments.
- Existing four-weight facial truncation, neutral tooth visibility and low-poly silhouette limitations remain. These changes add editable identity, not new topology or skin textures.
- Base endpoints remain 25-year adults. No age-changing, child/baby, old-age, genital or expression targets were acquired for this expansion.
- Browser performance and polygon count do not establish usability on an actual weak GPU. Raw JSON payload increased; the converter records raw and gzip byte counts, but that does not mean the current server uses gzip.

Source provenance: `identity.manifest.json`; numeric validation: `identity.validation.json`; actual CPU skinning: `identity.three-validation.json`; browser report: `tests/identity-browser-verification.json`.
