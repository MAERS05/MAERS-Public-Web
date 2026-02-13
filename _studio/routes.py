import os
import urllib.parse
import json

# Services
from services import cms, photos, music, album, space, music_api

import config

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN" class="fixed-layout-page">
<head>
    <script src="shared/flash-guard.js"></script>
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
        <div class="main-card">
            <div class="placeholder-content">
                <div style="font-size: 4rem;">✨</div>
                <div class="placeholder-text">{title}</div>
                <p>New page created via Admin.</p>
            </div>
        </div>
    </div>
    <script type="module">
        import {{ renderPageHeader }} from './shared/simple-main.module.js';
        renderPageHeader("{title}", "index.html", "Back");
    </script>
</body>
</html>"""

def dispatch_get(path, query_params):
    parsed_path = path

    # 0. CMS Tags (Special Case)
    if parsed_path == '/api/cms/tag_categories':
        module = query_params.get('module', ['cms'])[0]
        return 200, cms.get_tag_categories(module)
    
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
        return music_api.get_video_info(bvid)

    
    
    # 4. Music - 获取音乐数据 API
    if parsed_path == '/api/music_data':
        data = cms.load_json('data/music-data.json', 'data/music-data.js')
        if data is not None:
            return 200, data
        return 404, {"error": "Music data not found"}
    
    if parsed_path == '/api/space/save_tree':
        # This is a POST-only API usually, but routes might direct here if misconfigured?
        # Actually dispatch_post handles this. Let's redirect logic if needed or just return 405.
        return 405, {"error": "Method Not Allowed"}

    # 5. Space - 获取收藏数据 API
    if parsed_path == '/api/space/collections':
        data = space.load_collections()
        return 200, data

    return 404, None  # 返回 None 让 SimpleHTTPRequestHandler 处理静态文件

def dispatch_post(path, query_params, body_data, file_data=None):
    
    # 0. CMS Tags (Special Case)
    if path == '/api/cms/save_tag_categories':
        module = query_params.get('module', ['cms'])[0]
        success = cms.save_tag_categories(body_data, module)
        if success:
            return 200, {"status": "success"}
        else:
            return 500, {"error": "Failed to save tag categories"}

    if path == '/api/cms/cleanup_tags':
        module = query_params.get('module', ['cms'])[0]
        result = cms.cleanup_unused_tags(module)
        if result.get('success'):
            return 200, result
        else:
            return 500, result
    
    if path == '/api/cms/rename_tag':
        module = query_params.get('module', ['cms'])[0]
        old_name = body_data.get('old_name')
        new_name = body_data.get('new_name')
        
        if not old_name or not new_name:
            return 400, {"error": "old_name and new_name are required"}
        
        result = cms.rename_tag(module, old_name, new_name)
        if result.get('success'):
            return 200, result
        else:
            return 400, result
    
    if path == '/api/cms/delete_tag':
        module = query_params.get('module', ['cms'])[0]
        tag_name = body_data.get('tag_name')
        
        if not tag_name:
            return 400, {"error": "tag_name is required"}
        
        result = cms.delete_tag(module, tag_name)
        if result.get('success'):
            return 200, result
        else:
            return 400, result

    # 1. CMS
    if path.startswith('/api/cms/'):
        # Check for granular tag update
        if path == '/api/cms/update_tags':
            module = query_params.get('module', ['notes'])[0]
            node_id = body_data.get('id')
            tags = body_data.get('tags', [])
            
            if not node_id:
                return 400, {"error": "Node ID is required"}
            
            try:
                if cms.update_node_tags(module, node_id, tags):
                    return 200, {"status": "success", "message": "Tags updated"}
                else:
                    return 404, {"error": "Node not found"}
            except Exception as e:
                return 500, {"error": str(e)}
        
        return cms.handle_request(path, 'POST', query_params, body_data)
    
    # 2. Photos (Upload/Delete/Reorder) (Ex-Album)
    clean_path = path.rstrip('/')
    if clean_path == '/upload':
        if not file_data:
            return 400, {"error": "Upload failed: No file data received (Check Service Worker body handling)"}
        return 200, photos.handle_upload(query_params, file_data)
    
    if clean_path == '/delete':
        return 200, photos.handle_delete(body_data)

    if clean_path == '/reorder':
        return 200, photos.handle_reorder(query_params, body_data)

    if clean_path == '/api/photos/update_tags':
        photo_id = body_data.get('id')
        tags = body_data.get('tags', [])
        
        if not photo_id:
            return 400, {"error": "Photo ID is required"}
            
        try:
            if photos.update_tags(photo_id, tags):
                return 200, {"status": "success"}
            else:
                return 404, {"error": "Photo not found"}
        except Exception as e:
            return 500, {"error": str(e)}

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
    
    # 5.5 CMS Tags APIs

    # 6. Space Management APIs
    if path == '/api/space/fetch_meta':
        url = body_data.get('url')
        if not url:
            return 400, {"error": "URL is required"}
        try:
            meta = space.fetch_url_metadata(url)
            return 200, meta
        except Exception as e:
            return 500, {"error": str(e)}
    
    if path == '/api/space/add':
        try:
            space.add_collection(body_data)
            return 200, {"status": "success"}
        except ValueError as e:
            return 400, {"error": str(e)}
        except Exception as e:
            return 500, {"error": str(e)}
    
    if path == '/api/space/update':
        item_id = body_data.get('id')
        update_data = body_data.get('data', {})
        if not item_id:
            return 400, {"error": "ID is required"}
        try:
            space.update_collection(item_id, update_data)
            return 200, {"status": "success"}
        except ValueError as e:
            return 404, {"error": str(e)}
        except Exception as e:
            return 500, {"error": str(e)}
    
    if path == '/api/space/delete':
        item_id = body_data.get('id')
        if not item_id:
            return 400, {"error": "ID is required"}
        try:
            space.delete_collection(item_id)
            return 200, {"status": "success"}
        except ValueError as e:
            return 404, {"error": str(e)}
        except Exception as e:
            return 500, {"error": str(e)}
    
    if path == '/api/space/reorder':
        id_list = body_data.get('ids', [])
        try:
            space.reorder_collections(id_list)
            return 200, {"status": "success"}
        except Exception as e:
            return 500, {"error": str(e)}

    # 6.5 Space Tree Save (New)
    if path == '/api/space/save_tree':
        # Direct file write to space-tree.json
        try:
            space_tree_path = os.path.join(config.DATA_DIR, 'space-tree.json')
            cms.save_json(space_tree_path, body_data)
            return 200, {"status": "success", "message": "Space tree saved"}
        except Exception as e:
            print(f"Error saving space tree: {e}")
            return 500, {"error": str(e)}

    # 6.6 Space Tag Update (Granular)
    if path == '/api/space/update_tags':
        node_id = body_data.get('id')
        tags = body_data.get('tags', [])
        if not node_id:
            return 400, {"error": "Node ID is required"}
        
        try:
            if space.update_node_tags(node_id, tags):
                return 200, {"status": "success", "message": "Tags updated"}
            else:
                return 404, {"error": "Node not found"}
        except Exception as e:
            return 500, {"error": str(e)}

    return 404, {"error": "API not found"}
