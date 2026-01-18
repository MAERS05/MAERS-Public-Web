import os

# 路径配置
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')

MODULES_JSON_FILE = os.path.join(PROJECT_ROOT, 'custom', 'index', 'admin', 'modules.json')
ALBUM_CONFIG_JSON = os.path.join(PROJECT_ROOT, 'custom', 'album', 'admin', 'album-config.json')
ALBUM_CONFIG_JS   = os.path.join(PROJECT_ROOT, 'custom', 'album', 'viewer', 'album-config.js')

