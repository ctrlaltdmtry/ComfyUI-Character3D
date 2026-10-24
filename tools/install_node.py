# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Character3D contributors
"""Install only an explicit runtime manifest into a selected custom_nodes root.

Never changes ComfyUI configuration, installs dependencies, or restarts a server.
An existing ComfyUI-CharacterSheet package is unrelated and is never touched.
"""

import argparse
import hashlib
from pathlib import Path
import shutil

PACKAGE_NAME = "ComfyUI-Character3D"
SOURCE = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    "i18n.js", "web/i18n.js", "web/i18n-editor.js", "web/i18n-controls.js", "web/i18n-node.js",
    "character-actor.js", "scene-controller.js", "scene-controls.js", "scene-controls.css", "web/scene-state.js",
    "section-controls.js", "section-controls.css", "web/section-state.js",
    "sheet-layout.js", "sheet-renderer.js", "sheet-controls.js", "sheet-controls.css", "web/sheet-state.js",
    "joint-picking.js", "joint-interaction.js", "rig-layers.js", "rig-controls.js",
    "two-bone-ik.js", "kinematic-pose.js", "kinematic-controls.js", "web/kinematic-state.js",
    "__init__.py", "character_3d.py", "portable_package.py", "package_routes.py", "pyproject.toml", "requirements.txt",
    "LICENSE", "README.md", "index.html", "style.css", "viewer.js", "camera-controller.js", "render-controls.js", "web/render-settings.js",
    "rig-controller.js", "face-controller.js", "face-contact.js", "eye-surface.js", "assets/face-contact.json", "editor-bridge.js",
    "identity-morphs.js", "identity-controls.js", "identity-markers.js", "identity.css",
    "assets/identity.json", "assets/identity.manifest.json", "assets/README-identity.md",
    "web/extension.js", "web/state.js", "web/hash.js", "web/package.js",
    "vendor/three.module.js", "vendor/three.core.js", "vendor/OrbitControls.js",
    "vendor/TransformControls.js", "vendor/THREE-LICENSE.txt",
    "assets/human.json", "assets/eyes-brown.png", "assets/human.manifest.json",
    "assets/rig.json", "assets/rig.manifest.json", "assets/face-rig.json",
    "assets/face-morphs.json", "assets/face-parts.json", "assets/face.manifest.json",
    "assets/README-human.md", "assets/README-rig.md", "assets/README-face.md",
    "assets/LICENSE.ASSETS.md",
)


def _hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def install(custom_nodes, *, update=False, dry_run=False, source=SOURCE):
    source = Path(source).resolve()
    root = Path(custom_nodes).expanduser().resolve()
    target = root / PACKAGE_NAME
    if target.is_symlink() or target.resolve() != target:
        raise ValueError("Target must not be a symlink or junction.")
    if target == source or source in target.parents or target in source.parents:
        raise ValueError("Installation target must not overlap the source package.")
    if target.exists() and not update:
        raise ValueError("Target exists; explicit --update is required to overwrite this package.")
    if target.exists() and not target.is_dir():
        raise ValueError("Installation target is not a directory.")
    # Complete preflight before any directory creation or overwrite.
    hashes = {}
    for relative in RUNTIME_FILES:
        src, dst = source / relative, target / relative
        if src.resolve() != src or not src.is_file():
            raise ValueError("Missing or symlinked release file: " + relative)
        if dst.resolve() != dst or dst.is_symlink():
            raise ValueError("Destination is a symlink or junction: " + relative)
        if dst.exists() and not dst.is_file():
            raise ValueError("Destination is not a regular file: " + relative)
        for parent in dst.parents:
            if parent == root:
                break
            if parent.exists() and not parent.is_dir():
                raise ValueError("Destination parent is not a directory: " + str(parent))
        hashes[relative] = _hash(src)
    if dry_run:
        return target, hashes
    for relative, expected in hashes.items():
        src, dst = source / relative, target / relative
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if _hash(dst) != expected:
            raise OSError("SHA256 verification failed: " + relative)
    return target, hashes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("custom_nodes", help="Explicit destination custom_nodes directory")
    parser.add_argument("--update", action="store_true", help="Allow overwriting only ComfyUI-Character3D")
    parser.add_argument("--dry-run", action="store_true", help="Validate and list files; write nothing")
    args = parser.parse_args(argv)
    try:
        target, hashes = install(args.custom_nodes, update=args.update, dry_run=args.dry_run)
    except (ValueError, OSError) as exc:
        parser.exit(1, str(exc) + "\n")
    if args.dry_run:
        print(f"Dry run: {len(hashes)} SHA256-read runtime files -> {target}; no files written.")
        for relative, digest in hashes.items():
            print(f"{digest}  {relative}")
    else:
        print(f"Installed and SHA256-verified {len(hashes)} runtime files in {target}.")
    print("No dependencies installed, no other package modified, no server restarted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
