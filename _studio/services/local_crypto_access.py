"""本机免密管理：使用 Windows 当前用户的 DPAPI 保存包裹密钥，经回环鉴权恢复管理会话。"""
import base64
import ctypes
import json
import os
from . import storage, storage_journal, crypto_keyring, private_session


def _path():
    return os.path.join(storage_journal.local_root(), 'crypto-local-access.json')


def _protect(data, decrypt=False):
    if os.name != 'nt':
        raise OSError('本机免密管理需要 Windows 用户密钥保护')
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    library = ctypes.WinDLL('crypt32', use_last_error=True)
    function = library.CryptUnprotectData if decrypt else library.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    free = ctypes.WinDLL('kernel32').LocalFree
    free.argtypes, free.restype = [ctypes.c_void_p], ctypes.c_void_p
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise OSError('Windows 无法读取本机免密密钥，请重新登记')
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.memset(target.data, 0, target.size)
        free(target.data)


def status():
    record = crypto_keyring._read(_path()) or {}
    return {'enabled': record.get('enabled') is not False and bool(record.get('protected'))}


@storage.transactional
def configure(body):
    if not private_session.active():
        raise PermissionError('请先验证主密码，再修改本机免密管理')
    if body['enabled']:
        remember(private_session.session_keys(), force=True)
    else:
        # 删除已登记的包裹密钥，明确保存关闭状态，后续普通登录不能自动重新登记。
        storage.write_json(_path(), {'v': 1, 'enabled': False})
    return status()


@storage.transactional
def remember(keys, *, force=False):
    record = crypto_keyring._read(_path()) or {}
    if record.get('enabled') is False and not force:
        return
    ring = crypto_keyring._load()
    if not keys.get('default') or not all(private_session.key_matches(group, raw, ring)
                                          for group, raw in keys.items()):
        raise ValueError('本机登记密钥不匹配')
    protected = _protect(json.dumps({'v': 1, 'keys': keys}, separators=(',', ':')).encode())
    storage.write_json(_path(), {'v': 1, 'enabled': True, 'protected': base64.b64encode(protected).decode()})


def open_session():
    ring = crypto_keyring._load()
    if not ring:
        if private_session.status()['has_encrypted']:
            return 409, {'error': '本机缺少密钥环，请恢复完整密钥环备份'}
        return 200, {'configured': False, 'keys': {}}
    record = crypto_keyring._read(_path()) or {}
    if record.get('enabled') is False:
        return 428, {'code': 'local_password_required', 'error': '免密管理已关闭，请输入主密码'}
    try:
        if record.get('v') != 1:
            raise ValueError('未登记')
        data = json.loads(_protect(base64.b64decode(record['protected'], validate=True), decrypt=True))
        keys = {group: raw for group, raw in data['keys'].items()
                if private_session.key_matches(group, raw, ring)}
        if data.get('v') != 1 or 'default' not in keys:
            raise ValueError('管理密钥已变化')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return 428, {'code': 'local_enrollment_required',
                     'error': '首次登记本机免密管理需要验证一次管理密码，登记后启动自动管理全部内容'}
    try:
        private_session.start({'keys': keys})
        with private_session.context():
            for identity, group in ring.get('groups', {}).items():
                if not group.get('master_wrap'):
                    if identity not in keys:
                        raise ValueError('旧密码组需先接入管理密码，才能自动管理全部内容')
                    continue
                payload = private_session.crypt('decrypt', [group['master_wrap']])[0]
                if (payload.get('purpose') != 'master-group-v1' or payload.get('group') != identity
                        or not private_session.key_matches(identity, payload.get('k', ''), ring)):
                    raise ValueError('密码组的管理密钥槽不匹配，请恢复完整密钥环')
                keys[identity] = payload['k']
        result = private_session.start({'keys': keys})
    except Exception:
        private_session.close({})
        raise
    return 200, {**result, 'configured': True, 'keys': keys}
