# Genuine CC0 adult human preview assets

`human.json` contains authored MakeHuman hm08 body topology from MPFB, not generated anatomy. Both endpoints are **25-year-old adults**, with caucasian macro ancestry, average muscle and average weight. There are no child/baby mesh or target files in the downloaded assets.

## Renderer contract

- `positions`: flattened absolute female XYZ.
- `male`: flattened absolute male XYZ, identical vertex order/topology.
- `indices`: shared indexed triangles. Body contains exactly upstream OBJ group `body`; all helper/joint groups are excluded. All 13,378 authored body polygons survive, fan-triangulated without decimation or vertex splitting: **13,380 vertices, 26,756 triangles**. Facial topology is preserved.
- Compute smooth normals **after every deformation** (Three.js `BufferGeometry.computeVertexNormals()`). Body UV seams are deliberately not duplicated. No supplied normals can become stale.
- `morphs`: each `delta` is a displacement from the **female endpoint**, not an absolute mesh. Facial deltas are sex-independent upstream detail offsets. `maleDelta`, when present, is the corresponding displacement from the male endpoint; use it rather than the female body delta for male muscle/weight.
- `eyes`: genuine MakeHuman HighPolyEyes, fitted separately to both full deformed basemesh endpoints before discarding helpers. 1,076 vertices including UV seam duplication; 2,040 triangles. `positions`, `male`, `indices`, `uv` (flattened UV pairs), `texture: "eyes-brown.png"`. Texture path is relative to the assets directory; resolve it relative to the JSON URL. Use the supplied texture with normal OBJ UV convention (Three.js TextureLoader default flipY=true), sRGB color space. Upstream material uses transparency. Do not replace these authored eyes with generated spheres.
- `eyes.morphs` is aligned by `id` with body morphs; it contains female `delta` and `maleDelta` from actual MHCLO refitting. Apply these along with the body morphs.

For a gender blend `g` in [0,1] and morph strengths `w_i` in [0,1]:

```js
p[j] = (1-g)*data.positions[j] + g*data.male[j];
for (const m of data.morphs) {
  const dm = m.maleDelta ?? m.delta;
  p[j] += weight[m.id] * ((1-g)*m.delta[j] + g*dm[j]);
}
```

Use exactly the same equation with `data.eyes` for eyes. Baseline weights are zero. Independent muscle and weight sliders are a linear preview blend of separately authored endpoints, **not the full nonlinear MPFB muscle×weight macro grid**. Do not claim extreme combined settings are exact MakeHuman macro reconstruction. Individual endpoints are authentic; moderate combined settings are suitable for preview. Negative extrapolation is not a sourced opposite morph and is not recommended.

### Morph definitions

| ID | Actual source/meaning at strength 1 |
|---|---|
| `nose_width` | `nose/nose-scale-horiz-incr`: authored horizontal nose enlargement |
| `chin_width` | `chin/chin-width-incr`: authored chin width increase |
| `mouth_width` | `mouth/mouth-scale-horiz-incr`: authored horizontal mouth enlargement |
| `head_square` | `head/head-square`: authored square head shape |
| `muscle` | `universal-{sex}-young-maxmuscle-averageweight` **minus** `universal-{sex}-young-averagemuscle-averageweight` |
| `weight` | `universal-{sex}-young-averagemuscle-maxweight` **minus** `universal-{sex}-young-averagemuscle-averageweight` |

The universal endpoint subtraction is important: adding a complete alternate macro target onto an already macro-deformed body would double-count the average physique.

## Coordinates

Original OBJ coordinates, no rotations, centering or scale changes: **+Y up, +Z forward, X lateral**. Original MakeHuman size convention is decimetres (1 unit = 0.1 metre). Keep body and eyes in the same transform group. The source origin is not at the soles.

- Female bounds: min `[-4.9007, -8.1899, -0.9232]`, max `[4.9007, 7.8643, 2.9527]`.
- Male bounds: min `[-5.6857, -8.1810, -0.9764]`, max `[5.6857, 9.3003, 3.7787]`.
- Neutral adult authored pose, bald. This asset preparation does not certify renderer lighting/artistic quality; inspect the browser preview separately.

## Authentic macro composition, not filename guessing

The upstream target stack logic was inspected at the pinned links in `human.manifest.json`:

1. The race/sex/age macro layer and universal sex/age/muscle/weight layer are separate additive layers on the raw hm08 OBJ.
2. Pure adult female = raw OBJ + `caucasian-female-young` + `universal-female-young-averagemuscle-averageweight`, each weight 1. Male uses the two corresponding male targets.
3. These are **pure categorical endpoints**, not a byte-exact emulation of MPFB's UI epsilon interpolation/cutoff near gender 0 and 1. MPFB's small endpoint epsilon is intentionally not carried over. No unrelated neutral ethnic blend is added.
4. MakeHuman maps normalized age 0.5 to MID_AGE = 25 years. The `young` name therefore means a young **adult**, not a child.
5. Height and proportion at neutral have no extra target; the average-cup/average-firmness breast combination is explicitly excluded upstream and does not need another target.
6. Eye fitting uses the genuine MHCLO's weighted base-vertex references plus XYZ offsets scaled per axis by `abs(currentReferenceA-currentReferenceB)/declaredReferenceDistance`. Full basemesh helpers are retained internally for fitting, never rendered. The eye OBJ provides topology/UV; its source coordinates are replaced with fitted coordinates, as MakeHuman does.

The preparation program is an original standard-library Python implementation of these asset formats and mathematical relationships. Upstream GPL/AGPL program source was **read as reference, not copied, vendored or imported**. Downloaded OBJ, targets, eyes and textures are CC0 assets; upstream license texts are included under `sources/*/LICENSE*.md`.

## Reproduce and verify

From the project directory:

```text
python tools/prepare_human.py
python tools/prepare_human.py --offline
```

No package/system installation or Blender required. First run downloads only the pinned assets; reruns reuse the cache, validating SHA256 against the manifest. `--offline` errors if any source is missing. Results are deterministic (JSON float precision 6 decimals). `human.manifest.json` lists pinned URLs, source SHA256/size and output hash. `human.validation.json` reports finite/index checks, topology, nondegenerate triangles, bounds, morph endpoints and meaningful sex displacement.

## Files and follow-up

- `human.json`: browser artifact.
- `eyes-brown.png`: genuine CC0 eye texture.
- `human.manifest.json`: complete provenance and hashes.
- `human.validation.json`: actual numeric checks.
- `human.vertex-map.json`: compact body vertex index -> original hm08 vertex index (future rig weight remapping).
- `sources/`: the exact downloaded CC0 sources and both upstream license documents.
- `../tools/prepare_human.py`: reproducible offline-capable converter.

CC0 game-engine and default skeleton/weight assets exist upstream; pinned URLs are recorded in manifest `rigFollowup`. They have not been downloaded, converted or tested as a rig. Rigging is intentionally not part of this first geometry quality gate.
