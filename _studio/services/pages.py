"""门户页面创建与删除：基于项目绝对路径，校验文件名并转义标题。"""

import html
import json
import os
import config
from . import storage

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
        renderPageHeader({title_json}, "index.html", "Back");
    </script>
</body>
</html>"""


def _path(filename):
    if not isinstance(filename, str) or not filename.endswith('.html') or any(c in filename for c in ('..', '/', '\\', ':')):
        raise ValueError('Invalid filename')
    return os.path.join(config.PROJECT_ROOT, filename)


@storage.serialized
def ensure_page(body):
    path = _path(body.get('filename'))
    if os.path.exists(path):
        return 200, {'status': 'exists'}
    title = body.get('title', 'New Page')
    storage.write_text(path, PAGE_TEMPLATE.format(title=html.escape(title), title_json=json.dumps(title).replace('<', '\\u003c')))
    return 200, {'status': 'created'}


@storage.serialized
def delete_page(body):
    path = _path(body.get('filename'))
    if not os.path.isfile(path):
        return 404, {'error': 'File not found'}
    storage.remove(path)
    return 200, {'status': 'deleted'}
