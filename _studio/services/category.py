import sys
import os

# 添加父目录到 path 以导入兄弟模块 (cms_core)
# 注意：在 server.py 运行时 path 已经设置好了，但单独测试时可能需要
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from . import cms
import config

def handle_ops(path, body):
    conf = cms.load_json(config.ALBUM_CONFIG_JSON, config.ALBUM_CONFIG_JS) or []
    
    changed = False
    
    if path == '/api/reorder_category':
        old_map = {x['id']:x for x in conf}
        # body 是 id 列表
        new_conf = []
        for uid in body:
            if uid in old_map:
                new_conf.append(old_map[uid])
        
        # 补全可能遗漏的
        existing = set(body)
        for x in conf:
            if x['id'] not in existing:
                new_conf.append(x)
        conf = new_conf
        changed = True

    elif path == '/api/add_category': 
        # body 是 new item
        if not any(c['id'] == body.get('id') for c in conf): 
            conf.append(body)
            changed = True
            
    elif path == '/api/delete_category': 
        # body 是 {id: '...'}
        target_id = body.get('id')
        initial_len = len(conf)
        conf = [c for c in conf if c['id'] != target_id]
        if len(conf) < initial_len:
            changed = True
            
    elif path == '/api/update_category':
        target_id = body.get('id')
        for c in conf: 
            if c['id'] == target_id: 
                c.update(body)
                changed = True

    if changed:
        cms.save_json(config.ALBUM_CONFIG_JSON, conf, config.ALBUM_CONFIG_JS, 'CATEGORY_CONFIG')
    
    return 200, {"status": "success"}
