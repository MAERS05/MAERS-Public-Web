"""
后端全局配置：项目路径常量、数据目录、端口与外部服务参数（单一数据源）。
"""

import os

# 本地管理服务与请求体上限（读取请求体前检查）。
HOST = '127.0.0.1'
PORT = 8001
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_UPLOAD_BYTES = 64 * 1024 * 1024

# 路径配置
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')

# 业务配置文件 (Business Config Files)
MODULES_JSON_FILE = os.path.join(DATA_DIR, 'admin-portal.json')
ALBUM_CONFIG_JSON = os.path.join(DATA_DIR, 'album-config.json')
INDEX_CARDS_JSON  = os.path.join(DATA_DIR, 'index-cards.json')
CHANGELOG_JSON   = os.path.join(DATA_DIR, 'changelog.json')

# 核心存储与数据库 (Core Storage & Databases)
PHOTOS_ROOT = os.path.join(PROJECT_ROOT, 'photos')
CMS_DB      = os.path.join(DATA_DIR, 'cms.db')
GALLERY_DB  = os.path.join(DATA_DIR, 'gallery.db')
MUSIC_DATA  = os.path.join(DATA_DIR, 'music-data.json')
SPACE_DATA  = os.path.join(DATA_DIR, 'space-tree.json')


if __name__ == '__main__':
    # 桌面启动器通过当前 Python 读取配置，避免再次维护端口常量。
    import sys
    if sys.argv[1:] == ['--port']:
        print(PORT)
    else:
        raise SystemExit('Usage: config.py --port')
