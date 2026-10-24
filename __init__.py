# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Character3D contributors
from .character_3d import Character3DEditor, register_editor_routes

NODE_CLASS_MAPPINGS = {"Character3DEditor": Character3DEditor}
NODE_DISPLAY_NAME_MAPPINGS = {"Character3DEditor": "Character / 3D Editor"}
WEB_DIRECTORY = "./web"

register_editor_routes()

from .package_routes import register_package_routes
register_package_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
