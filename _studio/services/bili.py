import urllib.request
import json
import urllib.parse

def get_video_info(bvid):
    if not bvid:
        return 400, {"error": "Missing bvid"}
    
    try:
        api_url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('code') == 0:
                v = data['data']
                result = { 
                    "title": v['title'], 
                    "duration": v['duration'], 
                    "cover": v['pic'],
                    "pages": [{"page": p['page'], "part": p['part'], "duration": p['duration']} for p in v.get('pages', [])] 
                }
                return 200, result
            else:
                return 404, {"error": "Video not found or API error", "bili_code": data.get('code')}
    except Exception as e:
        return 500, {"error": str(e)}
