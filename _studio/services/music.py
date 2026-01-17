from . import cms

MUSIC_JSON_FILE   = 'data/music-data.json'
MUSIC_JS_FILE     = 'data/music-data.js'

def save_music_data(data):
    """保存音乐数据"""
    cms.save_json(MUSIC_JSON_FILE, data, MUSIC_JS_FILE, 'musicData')
    return {}

def delete_track(body):
    """删除指定音轨"""
    c, l, a, t = body['catIdx'], body['colIdx'], body['albIdx'], body['trackIdx']
    m = cms.load_json(MUSIC_JSON_FILE, MUSIC_JS_FILE)
    
    try:
        alb = m[c]['collections'][l]['albums'][a]
        if 'page_mapping' not in alb: alb['page_mapping'] = list(range(1, alb.get('total', 1)+1))
        if 'custom_parts' not in alb: alb['custom_parts'] = []
        
        if 0 <= t < len(alb['page_mapping']):
            alb['page_mapping'].pop(t)
            if t < len(alb['custom_parts']): alb['custom_parts'].pop(t)
            alb['total'] = len(alb['page_mapping'])
            cms.save_json(MUSIC_JSON_FILE, m, MUSIC_JS_FILE, 'musicData')
        return {}
    except (IndexError, KeyError) as e:
        print(f"❌ [Music] Delete track error: {e}")
        raise e

def reset_tracks(body):
    """重置专辑音轨"""
    c, l, a = body['catIdx'], body['colIdx'], body['albIdx']
    m = cms.load_json(MUSIC_JSON_FILE, MUSIC_JS_FILE)
    
    try:
        alb = m[c]['collections'][l]['albums'][a]
        orig = alb.get('bili_total', alb.get('total', 1))
        alb['page_mapping'] = list(range(1, orig+1))
        alb['total'] = orig
        alb['custom_parts'] = []
        cms.save_json(MUSIC_JSON_FILE, m, MUSIC_JS_FILE, 'musicData')
        return {}
    except (IndexError, KeyError) as e:
        print(f"❌ [Music] Reset tracks error: {e}")
        raise e
