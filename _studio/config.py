import os

# 路径配置
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')

# 业务配置文件 (Business Config Files)
MODULES_JSON_FILE = os.path.join(PROJECT_ROOT, 'custom', 'index', 'admin', 'modules.json')
ALBUM_CONFIG_JSON = os.path.join(DATA_DIR, 'album-config.json')
ALBUM_CONFIG_JS   = os.path.join(PROJECT_ROOT, 'custom', 'album', 'viewer', 'album-config.module.js')
INDEX_CARDS_JSON  = os.path.join(DATA_DIR, 'index-cards.json')

# 核心存储与数据库 (Core Storage & Databases)
PHOTOS_ROOT = os.path.join(PROJECT_ROOT, 'photos')
CMS_DB      = os.path.join(DATA_DIR, 'cms.db')
GALLERY_DB  = os.path.join(DATA_DIR, 'gallery.db')
MUSIC_DATA  = os.path.join(DATA_DIR, 'music-data.json')
MUSIC_DATA_JS = os.path.join(DATA_DIR, 'music-data.js')
