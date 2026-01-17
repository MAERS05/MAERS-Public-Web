import urllib.parse
import json

# Services
from services import cms, album, music, bili, category
import config

def dispatch_get(path, query_params):
    parsed_path = path
    
    # 1. CMS
    if parsed_path.startswith('/api/cms/'):
        return cms.handle_request(parsed_path, 'GET', query_params, None)
    
    # 2. General Modules
    if parsed_path == '/api/modules' or parsed_path == '/api/save_modules':
        data = cms.load_json(config.MODULES_JSON_FILE) or []
        return 200, data
    
    # 3. Bilibili
    if parsed_path == '/api/get_bili_info':
        bvid = query_params.get('bvid', [None])[0]
        return bili.get_video_info(bvid)
    
    # 4. Music
    if parsed_path == '/api/music_data':
         # music.py 好像没有 get ?
         # 查看 server.py 原逻辑，音乐获取直接 load json，这里 data-provider 是直接请求 json 文件的
         # 如果有 API 请求，可以添加
         pass

    return 404, None  # 返回 None 让 SimpleHTTPRequestHandler 处理静态文件

def dispatch_post(path, query_params, body_data, file_data=None):
    
    # 1. CMS
    if path.startswith('/api/cms/'):
        return cms.handle_request(path, 'POST', query_params, body_data)
    
    # 2. Album (Upload/Delete/Reorder)
    if path == '/upload' and file_data:
        return 200, album.handle_upload(query_params, file_data)
    
    if path == '/delete':
        return 200, album.handle_delete(body_data)

    if path == '/reorder':
        return 200, album.handle_reorder(query_params, body_data)

    # 3. Music
    if path == '/api/save_music':
        music.save_music_data(body_data)
        return 200, {}
    
    if path == '/api/delete_track':
        music.delete_track(body_data)
        return 200, {}

    if path == '/api/reset_tracks':
        music.reset_tracks(body_data)
        return 200, {}

    # 4. Modules & Categories
    if path == '/api/save_modules':
        cms.save_json(config.MODULES_JSON_FILE, body_data)
        return 200, {"status": "success"}

    if path in ['/api/add_category', '/api/delete_category', '/api/reorder_category', '/api/update_category']:
        return category.handle_ops(path, body_data)

    return 404, {"error": "API not found"}
