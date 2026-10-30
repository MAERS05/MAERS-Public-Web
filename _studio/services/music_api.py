"""
MAERS Music API Module
用于集成各种音乐/视频平台的 API 获取。
"""

from .errors import internal_error
import urllib.request
import json
import urllib.parse

# ==========================================
# BILIBILI API
# ==========================================

def get_video_info(bvid):
    if not bvid:
        return 400, {"error": "Missing bvid"}
    
    try:
        print(f"  [ BILI ] 🌐 正在获取元数据 | Fetching metadata for: {bvid}")
        api_url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('code') == 0:
                v = data['data']
                print(f"  [ BILI ] ✅ 元数据获取成功 | Metadata retrieved: {v['title']}")
                result = { 
                    "title": v['title'], 
                    "duration": v['duration'], 
                    "cover": v['pic'],
                    "pages": [{"page": p['page'], "part": p['part'], "duration": p['duration']} for p in v.get('pages', [])] 
                }
                return 200, result
            else:
                print(f"  [ BILI ] ⚠️  API 响应错误 | API Error: {data.get('code')}")
                return 404, {"error": "Video not found or API error", "bili_code": data.get('code')}
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f"  [ BILI ] ❌ 网络请求失败 | Network Error: {e}")
        return internal_error(e, "music_api.py")
