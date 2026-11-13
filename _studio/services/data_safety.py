"""本机数据保障：清理前校验、隔离回收区、本机与云端备份及恢复。"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
import config
from . import storage, storage_journal, cms_store, local_media, media_store


def _id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{32}', value):
        raise ValueError('Invalid recovery identifier')
    return value


def _default_backups_root():
    return os.path.join(storage_journal.local_root(), 'backups')


def _location_file():
    return os.path.join(storage_journal.local_root(), 'backup-location.json')


def backups_root():
    path = _location_file()
    if os.path.isfile(path):
        try:
            with open(path, encoding='utf-8') as source:
                configured = json.load(source).get('path', '')
            if isinstance(configured, str) and configured.strip():
                return os.path.realpath(configured.strip())
        except (OSError, ValueError):
            pass
    return _default_backups_root()


def _directory(kind, identity):
    checked = _id(identity)
    if kind != 'backups':
        return os.path.join(storage_journal.local_root(), kind, checked)
    primary = os.path.join(backups_root(), checked)
    if os.path.isdir(primary):
        return primary
    fallback = os.path.join(_default_backups_root(), checked)
    return fallback if os.path.isdir(fallback) else primary


def _relative(path):
    root = os.path.realpath(config.PROJECT_ROOT)
    target = os.path.realpath(path)
    if os.path.commonpath([root, target]) != root:
        raise ValueError('Recovery source escapes project')
    return os.path.relpath(target, root).replace('\\', '/')


def _target(relative):
    if not isinstance(relative, str) or relative.startswith(('/', '\\')) or '\\' in relative:
        raise ValueError('Invalid recovery path')
    parts = relative.split('/')
    private_media = (len(parts) == 8 and parts[:3] == ['_studio', '.local', 'private-media'] and
                     re.fullmatch(r'[a-f0-9]{64}', parts[3]))
    if private_media:
        media_store._key('/'.join(parts[4:]))
    local_state = ('_studio/.local/crypto-keyring.json', '_studio/.local/media-outbox.json',
                   f'_studio/.local/{local_media.PRIVATE_KEYS_FILE}')
    if '..' in parts or ':' in relative or not parts or (parts[0] not in ('data', 'photos', 'markdown')
            and relative not in local_state and not private_media):
        raise ValueError('Invalid recovery path')
    path = os.path.join(config.PROJECT_ROOT, *parts)
    _relative(path)
    return path


def preflight_cleanup():
    from . import cms, photos, validation
    for module in cms.JS_SYNC_MAP:
        tree = cms_store.load(os.path.join(config.DATA_DIR, f'{module}-tree.json'))
        for node in cms_store.walk(tree['root']):
            content = str(node.get('content') or '')
            if not node.get('_enc') and content.endswith('.md'):
                path = cms.cms_nodes._md_path(cms.get_context(), content)
                if not os.path.isfile(path):
                    raise FileNotFoundError('Referenced markdown is missing; cleanup stopped')
    for path, expected in ((photos.GALLERY_JSON_FILE, dict), (config.ALBUM_CONFIG_JSON, list),
                           (config.MUSIC_DATA, list), (config.SPACE_DATA, dict)):
        with open(path, encoding='utf-8') as source:
            value = json.load(source)
        if not isinstance(value, expected):
            raise ValueError('Invalid source; cleanup stopped')
        if path == config.SPACE_DATA:
            validation.tree(value)


def quarantine(path, batch):
    relative = _relative(path)
    _target(relative)
    directory = _directory('trash', batch)
    manifest = os.path.join(directory, 'manifest.json')
    entries = []
    if os.path.isfile(manifest):
        with open(manifest, encoding='utf-8') as source:
            entries = json.load(source)['files']
    with open(path, 'rb') as source:
        data = source.read()
    name = hashlib.sha256(relative.encode()).hexdigest()
    storage.write_bytes(os.path.join(directory, name), data)
    entries.append({'path': relative, 'blob': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    storage.write_json(manifest, {'v': 1, 'created': time.time(), 'files': entries})
    storage.remove(path)


def _read_verified(directory):
    with open(os.path.join(directory, 'manifest.json'), encoding='utf-8') as source:
        manifest = json.load(source)
    if manifest.get('v') != 1 or not isinstance(manifest.get('files'), list):
        raise ValueError('Invalid recovery manifest')
    for item in manifest['files']:
        blob = item['blob']
        if not isinstance(blob, str) or not re.fullmatch(r'[0-9a-f]{64}', blob):
            raise ValueError('Invalid backup blob')
        path = os.path.realpath(os.path.join(directory, blob))
        if os.path.commonpath([os.path.realpath(directory), path]) != os.path.realpath(directory):
            raise ValueError('Backup blob escapes directory')
        with open(path, 'rb') as source:
            data = source.read()
        if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Backup checksum mismatch')
    return manifest


@storage.transactional
def restore_trash(batch):
    directory = _directory('trash', batch)
    manifest = _read_verified(directory)
    # 整批先校验边界及目标冲突，绝不覆盖后来新建的同名内容。
    for item in manifest['files']:
        if os.path.exists(_target(item['path'])):
            raise ValueError('Restore target already exists; choose another location before restoring')
    for item in manifest['files']:
        with open(os.path.join(directory, item['blob']), 'rb') as source:
            storage.write_bytes(_target(item['path']), source.read())
    return {'status': 'success', 'restored': len(manifest['files'])}


def _local_files():
    from .crypto_keyring import local_keyring_file
    state = (os.path.join(storage_journal.local_root(), name) for name in ('media-outbox.json', local_media.PRIVATE_KEYS_FILE))
    for path in (local_keyring_file(), *state):
        if os.path.isfile(path):
            yield path
    for directory in (config.DATA_DIR, config.MARKDOWN_ROOT, config.PHOTOS_ROOT, os.path.join(storage_journal.local_root(), 'private-media')):
        for root, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = [name for name in dirs if _backup_directory(os.path.join(root, name))]
            for name in files:
                if name.startswith('.') or name.endswith(('.db', '.db-wal', '.db-shm')):
                    continue
                path = os.path.join(root, name)
                if not os.path.islink(path):
                    yield path


def _backup_directory(path):
    """备份遍历跳过隐藏目录、符号链接及 Windows 联接。"""
    if os.path.basename(path).startswith('.') or os.path.islink(path):
        return False
    is_junction = getattr(os.path, 'isjunction', None)
    return not (is_junction and is_junction(path))


def _check_remote_target(scope, key):
    if scope not in ('public', 'private'):
        raise ValueError('Invalid backup media scope')
    if key.startswith('_maers/'):
        if scope != 'private':
            raise ValueError('Private policies cannot belong to the public scope')
        media_store.MediaStore._policy_key(key)
    elif key.startswith('markdown/'):
        media_store.MediaStore.content_key(key)
    else:
        media_store._key(key)


_BACKUP_HEADERS = ('ContentType', 'CacheControl', 'ContentEncoding')


def _backup_scope(manifest):
    scope = manifest.get('scope')
    if scope is None:
        if manifest.get('remote') is False:
            return 'local'
        if manifest.get('remote') is True:
            return 'legacy'
    return scope


def _verify_backup_dir(directory, *, legacy_journal=False):
    """核验指定目录内备份清单的范围、每个文件的校验和及目标路径。"""
    manifest = _read_verified(directory)
    scope = _backup_scope(manifest)
    if scope == 'legacy' and not legacy_journal:
        raise ValueError('旧合并备份需使用创建它的版本恢复')
    if scope not in ('local', 'cloud', 'legacy'):
        raise ValueError('备份范围无效')
    if scope == 'cloud' and not isinstance(manifest.get('buckets'), dict):
        raise ValueError('云端备份缺少桶归属信息')
    for item in manifest['files']:
        if scope == 'cloud':
            _check_remote_target(item.get('scope'), item['path'])
            if item.get('bucketId') not in manifest['buckets']:
                raise ValueError('云端备份包含未知的桶')
            headers = item.get('headers', {})
            if not isinstance(headers, dict) or any(
                    name not in _BACKUP_HEADERS or not isinstance(value, str) for name, value in headers.items()):
                raise ValueError('云端备份的对象头无效')
        elif scope == 'legacy' and item.get('scope'):
            _check_remote_target(item['scope'], item['path'])
        else:
            if item.get('scope') is not None:
                raise ValueError('本机备份不能包含云端对象')
            _target(item['path'])
    return {**manifest, 'scope': scope}


def _backup_manifest(identity, *, legacy_journal=False):
    """恢复前先核验范围、每个文件的校验和及目标路径。"""
    directory = _directory('backups', identity)
    return directory, _verify_backup_dir(directory, legacy_journal=legacy_journal)


def _bucket_targets(store):
    return {bucket_id: store.bucket_target(bucket_id) for bucket_id in (media_store.DEFAULT_BUCKET, *store.bucket_groups)}


def _cloud_keys(store, buckets):
    for bucket_id in buckets:
        for scope in ('public', 'private'):
            prefixes = ('photos/', 'markdown/', '_maers/') if scope == 'private' else ('photos/', 'markdown/')
            for prefix in prefixes:
                for key in store._list_keys(scope, prefix, bucket_id=bucket_id):
                    if prefix == '_maers/':
                        try:
                            store._policy_key(key)
                        except ValueError:
                            continue
                    if prefix == 'markdown/' and not key.endswith('.md'):
                        continue
                    _check_remote_target(scope, key)
                    yield bucket_id, scope, key


def _read_cloud_object(store, bucket_id, scope, key):
    response = store._object_request('get_object', scope, key, bucket_id=bucket_id)
    stream = response['Body']
    try:
        return stream.read(), {name: response[name] for name in _BACKUP_HEADERS if response.get(name)}
    finally:
        stream.close()


def _restore_entry(directory, item, store):
    with open(os.path.join(directory, item['blob']), 'rb') as source:
        data = source.read()
    scope, key = item.get('scope'), item['path']
    if scope is None:
        storage.write_bytes(_target(key), data)
    elif 'bucketId' in item:
        bucket_id = item['bucketId']
        store._object_request('put_object', scope, key, bucket_id=bucket_id, Body=data, **item.get('headers', {}))
        actual, _ = _read_cloud_object(store, bucket_id, scope, key)
        if hashlib.sha256(actual).hexdigest() != item['sha256']:
            raise ValueError('云端恢复校验失败')
    elif key.startswith('_maers/'):
        store.write_policy(key, data)
    elif key.startswith('markdown/'):
        store.write_content(key, data, scope=scope)
    else:
        store.write(scope, key, data)


@storage.serialized
def create_backup(scope):
    if scope not in ('local', 'cloud'):
        raise ValueError('请选择本机备份或云端备份')
    identity = uuid.uuid4().hex
    directory = os.path.join(backups_root(), identity)
    entries = []

    def add(path, data, **placement):
        name = hashlib.sha256(f"{placement.get('bucketId')}|{placement.get('scope')}|{path}".encode()).hexdigest()
        storage_journal.atomic(os.path.join(directory, name), data)
        entries.append({'path': path, 'blob': name, 'size': len(data),
                        'sha256': hashlib.sha256(data).hexdigest(), **placement})

    manifest = {'v': 1, 'created': time.time(), 'scope': scope, 'files': entries}
    if scope == 'local':
        for path in _local_files():
            with open(path, 'rb') as source:
                add(_relative(path), source.read())
    else:
        store = media_store.get_store()
        if store.client is None:
            raise ValueError('创建云端备份前请配置 B2 或 R2 存储桶')
        manifest['buckets'] = _bucket_targets(store)
        for bucket_id, media_scope, key in _cloud_keys(store, manifest['buckets']):
            data, headers = _read_cloud_object(store, bucket_id, media_scope, key)
            add(key, data, scope=media_scope, bucketId=bucket_id, headers=headers)
    storage_journal.atomic(os.path.join(directory, 'manifest.json'), json.dumps(manifest).encode())
    _backup_manifest(identity)
    return {'status': 'success', 'id': identity, 'files': len(entries), 'scope': scope}


@storage.serialized
def verify_backup(identity):
    _, manifest = _backup_manifest(identity)
    return {'status': 'success', 'files': len(manifest['files']), 'scope': manifest['scope']}


def _cloud_target(item):
    return item['bucketId'], item['scope'], item['path']


def _restore_cloud(directory, manifest, store, targets):
    if store.client is None or _bucket_targets(store) != manifest['buckets']:
        raise ValueError('请恢复备份时的云端桶配置后再继续')
    for bucket_id, scope, key in targets:
        if bucket_id not in manifest['buckets']:
            raise ValueError('云端恢复包含未知的桶')
        _check_remote_target(scope, key)
    expected = {_cloud_target(item) for item in manifest['files']}
    for item in sorted(manifest['files'], key=lambda entry: not entry['path'].startswith('_maers/')):
        _restore_entry(directory, item, store)
    for bucket_id, scope, key in targets:
        if (bucket_id, scope, key) not in expected:
            store._delete_remote(scope, key, bucket_id=bucket_id)
    store._routes.clear()


@storage.transactional
def restore_backup(identity):
    """只恢复备份所属的一侧，并为这一侧保存恢复前快照。"""
    directory, manifest = _backup_manifest(identity)
    scope = manifest['scope']
    if scope == 'local':
        current = create_backup(scope)
        local_targets = {item['path'] for item in manifest['files']}
        batch = uuid.uuid4().hex
        for path in list(_local_files()):
            if _relative(path) not in local_targets:
                quarantine(path, batch)
        for item in manifest['files']:
            _restore_entry(directory, item, None)
        from . import crypto_keyring
        crypto_keyring.migrate()
        storage.on_commit(local_media.migrate_legacy)
    else:
        store = media_store.get_store()
        if store.client is None or _bucket_targets(store) != manifest['buckets']:
            raise ValueError('请恢复备份时的云端桶配置后再继续')
        current = create_backup(scope)
        snapshot = _read_verified(_directory('backups', current['id']))
        targets = sorted({_cloud_target(item) for item in manifest['files'] + snapshot['files']})
        record = {'kind': 'backup', 'scope': scope, 'id': current['id'], 'targets': targets}
        storage.compensate(record, lambda: recover_backup(record))
        _restore_cloud(directory, manifest, store, targets)
    return {'status': 'success', 'scope': scope, 'restored': len(manifest['files']), 'safety_backup': current['id']}


def recover_backup(record):
    directory, manifest = _backup_manifest(record['id'], legacy_journal=True)
    store = media_store.get_store()
    if record.get('scope') == 'cloud':
        if manifest['scope'] != 'cloud':
            raise ValueError('云端恢复日志与备份范围不匹配')
        _restore_cloud(directory, manifest, store, record['targets'])
        return
    # 旧版事务日志必须先回滚完毕，用户手动恢复只接受新范围或旧版纯本机备份。
    if store.identity() != record['backend']:
        raise RuntimeError('Restore original media configuration before recovery')
    originals = {(item['scope'], item['path']): item for item in manifest['files'] if item.get('scope')}
    for scope, key in record['targets']:
        _check_remote_target(scope, key)
    for scope, key in sorted(record['targets'], key=lambda target: target[1].startswith('_maers/')):
        if (scope, key) not in originals:
            if key.startswith('_maers/'):
                store.delete_policy(key)
            elif key.startswith('markdown/'):
                store.delete_content(key, scope=scope)
            else:
                store.delete(scope, key)
    for scope, key in sorted(record['targets'], key=lambda target: not target[1].startswith('_maers/')):
        item = originals.get((scope, key))
        if item:
            _restore_entry(directory, item, store)


def _validate_external_dir(raw_path, *, must_exist=False):
    if not isinstance(raw_path, str) or not raw_path.strip() or any(ord(c) < 32 for c in raw_path):
        raise ValueError('请输入有效的文件夹路径')
    expanded = os.path.expanduser(raw_path.strip())
    if not os.path.isabs(expanded):
        raise ValueError('备份目录请使用完整的绝对路径')
    is_junction = getattr(os.path, 'isjunction', None)
    if os.path.exists(expanded) and (os.path.islink(expanded) or (is_junction and is_junction(expanded))):
        raise ValueError('备份目录不能使用符号链接或目录联接')
    target = os.path.realpath(expanded)
    if must_exist and not os.path.isdir(target):
        raise ValueError('所选文件夹不存在')
    return target


@storage.serialized
def set_backup_location(raw_path):
    """设置自定义备份保存目录；传入空字符串时恢复默认位置。"""
    if not isinstance(raw_path, str):
        raise ValueError('备份目录格式无效')
    cleaned = raw_path.strip()
    default_real = os.path.realpath(_default_backups_root())
    location = _location_file()
    if not cleaned:
        if os.path.isfile(location):
            os.remove(location)
        return list_recovery()
    target = _validate_external_dir(cleaned)
    if os.path.normcase(target) == os.path.normcase(default_real):
        if os.path.isfile(location):
            os.remove(location)
        return list_recovery()
    if os.path.dirname(target) == target:
        raise ValueError('请选择磁盘下的具体文件夹，不要直接使用磁盘根目录')
    project_real = os.path.realpath(config.PROJECT_ROOT)
    try:
        inside_project = os.path.commonpath([os.path.normcase(project_real), os.path.normcase(target)]) == os.path.normcase(project_real)
    except ValueError:
        inside_project = False
    if inside_project:
        raise ValueError('自定义备份目录请选择项目文件夹以外的独立位置')
    os.makedirs(target, exist_ok=True)
    storage_journal.atomic(location, json.dumps({'path': target}, ensure_ascii=False).encode('utf-8'))
    return list_recovery()


@storage.serialized
def import_backup(raw_path):
    """从外部目录校验并导入单个或整批备份包到当前备份目录。"""
    source_root = _validate_external_dir(raw_path, must_exist=True)
    root_path = Path(source_root)
    if (root_path / 'manifest.json').is_file():
        candidates = [root_path]
    else:
        candidates = sorted(
            [child for child in root_path.iterdir()
             if child.is_dir() and _backup_directory(str(child)) and (child / 'manifest.json').is_file()],
            key=lambda item: item.name
        )
    if not candidates:
        raise ValueError('所选目录中未找到有效的备份包 (manifest.json)')

    verified = [(candidate, _verify_backup_dir(str(candidate))) for candidate in candidates]
    dest_root = Path(backups_root())
    dest_root.mkdir(parents=True, exist_ok=True)
    dest_real = os.path.normcase(os.path.realpath(str(dest_root)))
    imported_ids = []

    for candidate, manifest in verified:
        manifest_bytes = (candidate / 'manifest.json').read_bytes()
        parent_real = os.path.normcase(os.path.realpath(str(candidate.parent)))
        if parent_real == dest_real and re.fullmatch(r'[0-9a-f]{32}', candidate.name):
            imported_ids.append(candidate.name)
            continue
        target_id = candidate.name if re.fullmatch(r'[0-9a-f]{32}', candidate.name) else uuid.uuid4().hex
        existing_manifest = dest_root / target_id / 'manifest.json'
        if existing_manifest.is_file():
            if existing_manifest.read_bytes() == manifest_bytes:
                _backup_manifest(target_id)
                imported_ids.append(target_id)
                continue
            target_id = uuid.uuid4().hex
        target_dir = dest_root / target_id
        for item in manifest['files']:
            blob_name = item['blob']
            storage_journal.atomic(str(target_dir / blob_name), (candidate / blob_name).read_bytes())
        storage_journal.atomic(str(target_dir / 'manifest.json'), manifest_bytes)
        _backup_manifest(target_id)
        imported_ids.append(target_id)

    return {'status': 'success', 'imported': len(imported_ids), 'ids': imported_ids}


_TK_PICKER_SCRIPT = """
import ctypes, os, sys, tkinter as tk
from tkinter import filedialog
if os.name == 'nt':
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass
root = tk.Tk()
if os.name == 'nt':
    root.attributes('-toolwindow', True)
root.attributes('-alpha', 0.0)
root.attributes('-topmost', True)
sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
root.geometry(f'1x1+{max(0, sw // 3)}+{max(0, sh // 4)}')
root.update()
if os.name == 'nt':
    try:
        u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
        hwnd = u32.GetParent(root.winfo_id()) or root.winfo_id()
        fg_tid = u32.GetWindowThreadProcessId(u32.GetForegroundWindow(), None)
        cur_tid = k32.GetCurrentThreadId()
        if fg_tid and fg_tid != cur_tid:
            u32.AttachThreadInput(fg_tid, cur_tid, True)
            u32.BringWindowToTop(hwnd)
            u32.SetForegroundWindow(hwnd)
            u32.AttachThreadInput(fg_tid, cur_tid, False)
        else:
            u32.SetForegroundWindow(hwnd)
    except Exception:
        pass
selected = filedialog.askdirectory(parent=root, title=sys.argv[1], mustexist=False) or ''
root.destroy()
sys.stdout.write(selected)
"""


def _python_cli_executable():
    """桌面启动器以 pythonw.exe 运行时切换同目录 python.exe，配合 CREATE_NO_WINDOW 稳定捕获标准输出。"""
    exe = sys.executable
    if os.name == 'nt' and exe.lower().endswith('pythonw.exe'):
        candidate = os.path.join(os.path.dirname(exe), 'python.exe')
        if os.path.isfile(candidate):
            return candidate
    return exe


def pick_directory(title='选择文件夹'):
    """调用系统原生置顶文件夹选择框，确保显示在管理端窗口正上方且不阻塞存储锁。"""
    safe_title = re.sub(r'[\r\n"\'`$]', '', str(title or '选择文件夹'))[:64] or '选择文件夹'
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
    completed = subprocess.run(
        [_python_cli_executable(), '-B', '-c', _TK_PICKER_SCRIPT, safe_title],
        capture_output=True, text=True, encoding='utf-8', timeout=300, creationflags=flags, env=env
    )
    if completed.returncode != 0 and os.name == 'nt':
        # 精简 Python 环境缺失 tkinter 时，回退至挂载 TopMost 宿主窗体的 PowerShell 对话框。
        ps_script = (
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
            "$owner = New-Object System.Windows.Forms.Form; "
            "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; "
            "$owner.FormBorderStyle = 'None'; $owner.Opacity = 0; "
            "$owner.Size = New-Object System.Drawing.Size(1, 1); "
            "$owner.StartPosition = 'CenterScreen'; $owner.Show(); $owner.Activate(); "
            "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog; "
            f"$dlg.Description = '{safe_title}'; $dlg.ShowNewFolderButton = $true; "
            "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }; "
            "$owner.Close()"
        )
        completed = subprocess.run(
            ['powershell', '-NoProfile', '-STA', '-Command', ps_script],
            capture_output=True, text=True, encoding='utf-8', timeout=300, creationflags=flags
        )
    selected = (completed.stdout or '').strip()
    return {'cancelled': not bool(selected), 'path': selected}


@storage.serialized
def list_recovery():
    current_backups = Path(backups_root())
    default_backups = Path(_default_backups_root())
    is_custom = os.path.normcase(os.path.realpath(str(current_backups))) != os.path.normcase(os.path.realpath(str(default_backups)))
    result = {'backup_dir': str(current_backups), 'is_custom_dir': is_custom}
    for kind, parent in (('trash', Path(storage_journal.local_root()) / 'trash'), ('backups', current_backups)):
        items = []
        if parent.is_dir():
            for directory in parent.iterdir():
                if re.fullmatch(r'[0-9a-f]{32}', directory.name) and (directory / 'manifest.json').is_file():
                    with (directory / 'manifest.json').open(encoding='utf-8') as source:
                        data = json.load(source)
                    item = {'id': directory.name, 'created': data['created'], 'files': len(data['files'])}
                    if kind == 'backups':
                        item['scope'] = _backup_scope(data)
                    items.append(item)
        result[kind] = sorted(items, key=lambda item: item['created'], reverse=True)
    return result
