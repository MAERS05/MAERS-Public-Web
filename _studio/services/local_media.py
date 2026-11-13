"""原图和衍生图统一留在图库目录，本机私密标记用于发布与清理。"""
import json
import os
import re
from filecmp import cmp
from pathlib import Path

import config
from . import photo_paths, storage, storage_journal

PRIVATE_KEYS_FILE = 'private-photo-keys.json'


def path(key):
    target = Path(photo_paths.media_path(key, config.PROJECT_ROOT))
    expected = Path(config.PROJECT_ROOT).resolve().joinpath(*key.split('/'))
    if target != expected:
        raise ValueError('图片路径不能使用符号链接或目录联接')
    return target


def _registry():
    return Path(storage_journal.local_root()) / PRIVATE_KEYS_FILE


def private_keys():
    try:
        keys = json.loads(_registry().read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    if not isinstance(keys, list):
        raise ValueError('本机私密图片索引无效')
    for key in keys:
        photo_paths.media_parts(key)
    return {os.path.normcase(key): key for key in keys}


def is_private(key, keys=None):
    keys = private_keys() if keys is None else keys
    return os.path.normcase(key) in keys


def set_private(keys, private=True):
    keys = set(keys)
    if not keys:
        return
    current = private_keys()
    changes = {os.path.normcase(key): key for key in keys}
    if private:
        for key in keys:
            path(key)
        updated = current | changes
    else:
        updated = {name: key for name, key in current.items() if name not in changes}
    if updated != current:
        storage.write_json(str(_registry()), sorted(updated.values()))


def keep(key, data):
    target = path(key)
    if not target.is_file() or target.read_bytes() != data:
        storage.write_bytes(target, data)


def files(root):
    for folder in ('images', 'previews', 'thumbnails'):
        for source in sorted((root / 'photos' / folder).glob('*/*')):
            if not source.is_file() or source.name.startswith('.'):
                continue
            if source.resolve() != source:
                raise ValueError('图片目录包含符号链接或目录联接')
            yield source.relative_to(root).as_posix(), source


@storage.serialized
def migrate_legacy():
    """先核对全部目标，登记私密标记后逐个迁移，重复执行可收尾。"""
    local = Path(config.PROJECT_ROOT).resolve() / '_studio' / '.local'
    cache = local / 'private-media'
    cache_roots = [item for item in cache.glob('*')
                   if item.is_dir() and re.fullmatch(r'[a-f0-9]{64}', item.name)]
    roots = [(local / 'media/public', False), (local / 'media/private', True)]
    roots.extend((root, True) for root in cache_roots)
    moves, destinations, protected = [], {}, set()
    for root, private in roots:
        for key, source in files(root):
            target = path(key)
            previous = destinations.get(target, target)
            if previous.exists() and not cmp(source, previous, shallow=False):
                raise ValueError(f'旧图片与图库有同名冲突，已保留两份：{key}')
            destinations[target] = source
            if private:
                protected.add(key)
            moves.append((source, target))
    set_private(protected)
    for source, target in moves:
        if target.is_file():
            source.unlink()  # 已验证内容相同。
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)
    # 清理已迁空的旧照片目录，保留本机令牌等非图片数据。
    for root, _ in roots:
        if root.resolve() != root:
            raise ValueError('旧图片目录不能使用符号链接或目录联接')
        for directory, _, _ in os.walk(root, topdown=False, followlinks=False):
            directory = Path(directory)
            if directory.resolve() != directory:
                raise ValueError('旧图片目录不能使用符号链接或目录联接')
            if not any(directory.iterdir()):
                directory.rmdir()
    if cache.is_dir() and not any(cache.iterdir()):
        cache.rmdir()
    return len(moves)
