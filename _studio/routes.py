import os
import urllib.parse
import json

# Services
from services import cms, photos, music, bili, album
import config

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <script src="dynamic-style/flash-guard.js"></script>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title} - MAERS</title>
    <link rel="preload" href="static-style/theme.css" as="style">
    <link rel="preload" href="static-style/components.css" as="style">
    <link rel="stylesheet" href="static-style/theme.css">
    <link rel="stylesheet" href="static-style/components.css">
    <link rel="stylesheet" href="static-style/style.css">
    <script type="module" src="data-manage/data-provider.module.js"></script>
    <style>
        .placeholder-content {{ flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; color: var(--text-sub); }}
        .placeholder-text {{ font-size: 2rem; font-weight: 700; color: var(--text-main); margin-top: 20px; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="main-card clean-layout">
            <div class="placeholder-content">
                <div style="font-size: 4rem;">✨</div>
                <div class="placeholder-text">{title}</div>
                <p>New page created via Admin.</p>
            </div>
        </div>
    </div>
    <script type="module">
        import {{ renderPageHeader }} from './custom/shared/simple-main.module.js';
        renderPageHeader("{title}", "index.html", "Back");
    </script>
</body>
</html>"""

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
    
    # 4. Music - 获取音乐数据 API
    if parsed_path == '/api/music_data':
        data = cms.load_json('data/music-data.json', 'data/music-data.js')
        if data is not None:
            return 200, data
        return 404, {"error": "Music data not found"}

    return 404, None  # 返回 None 让 SimpleHTTPRequestHandler 处理静态文件

def dispatch_post(path, query_params, body_data, file_data=None):
    
    # 1. CMS
    if path.startswith('/api/cms/'):
        return cms.handle_request(path, 'POST', query_params, body_data)
    
    # 2. Photos (Upload/Delete/Reorder) (Ex-Album)
    if path == '/upload' and file_data:
        return 200, photos.handle_upload(query_params, file_data)
    
    if path == '/delete':
        return 200, photos.handle_delete(body_data)

    if path == '/reorder':
        return 200, photos.handle_reorder(query_params, body_data)

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

    # 4. Modules & Albums (Categories)
    if path == '/api/save_modules':
        cms.save_json(config.MODULES_JSON_FILE, body_data)
        return 200, {"status": "success"}

    if path == '/api/save_index_cards':
        cms.save_json(config.INDEX_CARDS_JSON, body_data)
        return 200, {"status": "success"}

    # 5. Page Creation
    if path == '/api/ensure_page':
        filename = body_data.get('filename')
        title = body_data.get('title', 'New Page')
        
        if not filename or not filename.endswith('.html'):
            return 400, {"error": "Invalid filename"}
            
        # Security check: prevent directory traversal
        if '..' in filename or '/' in filename or '\\' in filename:
             return 400, {"error": "Invalid filename path"}

        file_path = os.path.join(os.getcwd(), filename) # Assume CWD is proj root
        
        if os.path.exists(file_path):
            return 200, {"status": "exists", "message": "Page already exists"}
            
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(PAGE_TEMPLATE.format(title=title))
            print(f"  [ PAGE ] ✨ 页面自动创建 | New page created: {filename}")
            return 200, {"status": "created", "message": f"Created new page: {filename}"}
        except Exception as e:
            return 500, {"error": str(e)}

    if path == '/api/delete_page':
        filename = body_data.get('filename')
        if not filename or not filename.endswith('.html'):
            return 400, {"error": "Invalid filename"}
        if '..' in filename or '/' in filename or '\\' in filename:
             return 400, {"error": "Invalid filename path"}
        
        file_path = os.path.join(os.getcwd(), filename)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                print(f"  [ PAGE ] 🗑️  页面物理删除 | Physical page deleted: {filename}")
                return 200, {"status": "deleted", "message": f"Deleted page: {filename}"}
            except Exception as e:
                return 500, {"error": str(e)}
        return 404, {"error": "File not found"}

    if path in ['/api/add_category', '/api/delete_category', '/api/reorder_category', '/api/update_category']:
        return album.handle_ops(path, body_data)

    return 404, {"error": "API not found"}
