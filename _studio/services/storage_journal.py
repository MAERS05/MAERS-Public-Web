"""本机持久化写前日志：在文件变更前保存旧版本，重启时恢复未完成事务。"""

import hashlib
import json
import os
import shutil
import tempfile
import uuid
import config
from contextlib import contextmanager


def local_root():
    return os.path.join(config.PROJECT_ROOT, '_studio', '.local')


@contextmanager
def process_lock():
    """管理服务和独立媒体工具互斥，不能由另一个进程绕过媒体写锁。"""
    os.makedirs(local_root(), exist_ok=True)
    path = os.path.join(local_root(), 'studio.lock')
    with open(path, 'a+b') as handle:
        handle.seek(0, os.SEEK_END)
        if not handle.tell():
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError('Studio or a media tool is already using this project') from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.journal-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


class Journal:
    def __init__(self, directory=None):
        self.directory = directory or os.path.join(local_root(), 'transactions', uuid.uuid4().hex)
        self.path = os.path.join(self.directory, 'manifest.json')
        self.data = {'v': 1, 'state': 'active', 'files': {}, 'remote': []}
        if directory:
            with open(self.path, encoding='utf-8') as source:
                self.data = json.load(source)
            if self.data.get('v') != 1 or self.data.get('state') not in ('active', 'committed'):
                raise ValueError('Invalid recovery journal')

    def save(self):
        atomic(self.path, json.dumps(self.data, ensure_ascii=False, allow_nan=False).encode('utf-8'))

    def remember(self, path):
        relative = os.path.relpath(path, config.PROJECT_ROOT).replace('\\', '/')
        # 本机回收区等状态文件也需要回滚，但不允许日志覆盖自身。
        root = os.path.realpath(config.PROJECT_ROOT)
        target = os.path.realpath(path)
        if os.path.commonpath([root, target]) != root:
            raise ValueError('Transaction target escapes project')
        if relative in self.data['files']:
            return
        previous = None
        if os.path.isfile(path):
            filename = hashlib.sha256(relative.encode()).hexdigest() + '.bak'
            backup = os.path.join(self.directory, filename)
            os.makedirs(self.directory, exist_ok=True)
            with open(path, 'rb') as source, open(backup, 'wb') as output:
                shutil.copyfileobj(source, output)
                output.flush()
                os.fsync(output.fileno())
            with open(backup, 'rb') as source:
                data = source.read()
            previous = {'blob': filename, 'sha256': hashlib.sha256(data).hexdigest()}
        self.data['files'][relative] = previous
        self.save()

    def remote(self, record):
        self.data['remote'].append(record)
        self.save()

    def restore_files(self):
        root = os.path.realpath(config.PROJECT_ROOT)
        for backup in self.data['files'].values():
            if backup is None:
                continue
            name = backup.get('blob')
            if not isinstance(name, str) or os.path.basename(name) != name:
                raise ValueError('Invalid recovery blob')
            with open(os.path.join(self.directory, name), 'rb') as source:
                if hashlib.sha256(source.read()).hexdigest() != backup['sha256']:
                    raise ValueError('Recovery journal checksum mismatch')
        for relative, backup in reversed(list(self.data['files'].items())):
            path = os.path.realpath(os.path.join(root, relative))
            if os.path.isabs(relative) or os.path.commonpath([root, path]) != root:
                raise ValueError('Recovery path escapes project')
            if os.path.commonpath([os.path.realpath(self.directory), path]) == os.path.realpath(self.directory):
                raise ValueError('Recovery path targets its journal')
            if backup is None:
                if os.path.isfile(path):
                    os.remove(path)
            else:
                with open(os.path.join(self.directory, backup['blob']), 'rb') as source:
                    atomic(path, source.read())

    def commit(self):
        if os.path.exists(self.path):
            self.data['state'] = 'committed'
            self.save()

    def discard(self):
        if os.path.isdir(self.directory):
            boundary = os.path.realpath(os.path.join(local_root(), 'transactions'))
            target = os.path.realpath(self.directory)
            if target == boundary or os.path.commonpath([boundary, target]) != boundary or os.path.islink(self.directory):
                raise ValueError('Journal cleanup escapes private storage')
            shutil.rmtree(self.directory)


def pending():
    directory = os.path.join(local_root(), 'transactions')
    if not os.path.isdir(directory):
        return []
    return [os.path.join(directory, name) for name in sorted(os.listdir(directory))
            if os.path.isfile(os.path.join(directory, name, 'manifest.json'))]


def recover():
    """恢复失败保留日志并抛错；启动服务和发布必须等待恢复完成。"""
    count = 0
    for directory in pending():
        journal = Journal(directory)
        if journal.data['state'] == 'active':
            journal.restore_files()
            if journal.data['remote']:
                from . import media_store
                for record in reversed(journal.data['remote']):
                    media_store.recover(record)
            count += 1
        journal.discard()
    return count
