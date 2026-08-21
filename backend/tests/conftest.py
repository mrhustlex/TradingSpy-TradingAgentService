import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULES_DIR = os.path.join(BACKEND_DIR, "modules")
for path in (BACKEND_DIR, MODULES_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)
