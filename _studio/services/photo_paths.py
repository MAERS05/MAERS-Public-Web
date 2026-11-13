"""图片逻辑路径：组件名、真实目录边界与引用格式的统一校验。"""
import os
import posixpath
import re
from urllib.parse import unquote, urlsplit

BASE_IMAGE_DIR = "photos/images"
THUMB_DIR = "photos/thumbnails"
PREVIEW_DIR = "photos/previews"
RESERVED_MEDIA_NAMES = {'CON', 'PRN', 'AUX', 'NUL',
                        *[f'COM{index}' for index in range(10)],
                        *[f'LPT{index}' for index in range(10)]}


def media_component(value):
    """拒绝路径分隔符、父目录、绝对路径及 Windows 特殊文件名。"""
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError('Invalid media name')
    if '..' in value or value.endswith('.') or re.search(r'[\\/:*?"<>|\x00-\x1f]', value):
        raise ValueError('Invalid media name')
    if value.split('.')[0].upper() in RESERVED_MEDIA_NAMES:
        raise ValueError('Invalid media name')
    return value


def media_parts(key):
    if not isinstance(key, str) or '\\' in key:
        raise ValueError('Invalid media path')
    parts = key.split('/')
    if len(parts) != 4 or parts[0] != 'photos' or parts[1] not in ('images', 'thumbnails', 'previews'):
        raise ValueError('Invalid media path')
    media_component(parts[2])
    media_component(parts[3])
    return parts


def media_path(key, project_root):
    """所有本地媒体读写都限制在三级图片目录，解析联接后再次检查边界。"""
    parts = media_parts(key)
    root = os.path.realpath(os.path.join(project_root, 'photos'))
    boundary = os.path.realpath(os.path.join(project_root, *parts[:2]))
    path = os.path.realpath(os.path.join(project_root, *parts))
    if (os.path.commonpath([root, boundary]) != root
            or os.path.commonpath([boundary, path]) != boundary):
        raise ValueError('Media path escapes storage directory')
    return path


def normalize_media_reference(value):
    """按浏览器 URL 语义统一图片引用：先去参数，再解码并消除相对路径片段。"""
    if not value:
        return ''
    path = urlsplit(str(value).replace('\\', '/')).path
    path = posixpath.normpath(unquote(path)).lstrip('/')
    media = re.search(r'(?:^|/)(photos/(?:images|previews|thumbnails)/.*)$', path)
    return media.group(1) if media else path


IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp', '.heic', '.heif')


def media_references(text):
    """收集正文及配置中的图片引用，排除反引号及中文标点，严格要求有效图片后缀。"""
    raw = re.findall(r'photos/(?:images|thumbnails|previews)/[^\s<>`"\'\x27)\]、，；：！？]+', text)
    result = []
    for key in raw:
        norm = normalize_media_reference(key)
        if any(norm.lower().endswith(ext) for ext in IMAGE_EXTENSIONS):
            result.append(key)
    return result
