"""共享存储边界：串行读改写、原子替换与多文件操作的异常回滚。"""

from typing import Callable, ParamSpec, TypeVar, Iterator
from .contracts import JsonValue

P = ParamSpec("P")
R = TypeVar("R")

import functools
import json
import os
import tempfile
import threading
import hashlib
import config
from . import storage_journal
from contextlib import contextmanager

LOCK = threading.RLock()
_state = threading.local()


def _recover_if_needed():
    if getattr(_state, 'undo', None) is None and not getattr(_state, 'recovering', False):
        _state.recovering = True
        try:
            storage_journal.recover()
        finally:
            _state.recovering = False


def serialized(function: Callable[P, R]) -> Callable[P, R]:
    """完整业务操作共用可重入锁，避免仅锁最后一次写入造成更新丢失。"""
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        with LOCK:
            _recover_if_needed()
            return function(*args, **kwargs)
    return wrapped


def _replace(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.maers-', suffix='.tmp', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def _remember(path):
    undo = getattr(_state, 'undo', None)
    if undo is not None and path not in undo:
        _state.journal.remember(path)
        undo[path] = True


def write_bytes(path: str, data: bytes) -> None:
    path = os.path.abspath(path)
    _remember(path)
    _replace(path, data)


def write_text(path: str, text: str) -> None:
    from . import private_session
    if private_session.write_document(path, text):
        return
    write_bytes(path, text.encode('utf-8'))


def write_json(path: str, data: JsonValue) -> None:
    from . import private_session
    data = private_session.prepare(path, data)
    write_text(path, json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def remove(path: str) -> None:
    path = os.path.abspath(path)
    if os.path.isfile(path):
        _remember(path)
        os.remove(path)


def on_commit(callback: Callable[[], None]) -> None:
    """外部副作用只在最外层文件事务成功后启动。"""
    callbacks = getattr(_state, 'callbacks', None)
    if callbacks is None:
        callback()
    else:
        callbacks.append(callback)


def on_rollback(callback: Callable[[], None]) -> None:
    """文件恢复后补偿外部副作用，覆盖外层回执保存失败的回滚。"""
    if not hasattr(_state, 'rollbacks'):
        raise RuntimeError('Rollback compensation requires a transaction')
    _state.rollbacks.append(callback)


def compensate(record, callback):
    """在外部写入之前持久化补偿计划，网络响应丢失和进程退出均可恢复。"""
    if not hasattr(_state, 'journal'):
        raise RuntimeError('Compensation requires a transaction')
    _state.journal.remote(record)
    on_rollback(callback)


def recover():
    with LOCK:
        if getattr(_state, 'undo', None) is not None:
            raise RuntimeError('Cannot recover inside a transaction')
        return storage_journal.recover()


def run_once(source, key, payload, operation):
    """中继操作与持久化回执共用文件事务，刷新或重启后仍可安全重放。"""
    if not isinstance(source, str) or not source or len(source) > 2048:
        raise ValueError('Invalid relay source')
    if not isinstance(key, str) or not key or len(key) > 512:
        raise ValueError('Invalid relay key')
    digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                                    allow_nan=False).encode('utf-8')).hexdigest()
    identity, fingerprint = digest([source, key]), digest(payload)
    path = os.path.join(config.DATA_DIR, '.relay-receipts.json')
    with transaction():
        receipts = {}
        if os.path.exists(path):
            with open(path, encoding='utf-8') as source_file:
                receipts = json.load(source_file)
            if not isinstance(receipts, dict):
                raise ValueError('Invalid relay receipts')
        previous = receipts.get(identity)
        if previous:
            if previous['fingerprint'] != fingerprint:
                return 409, {'error': 'Relay key already used for another operation'}
            return previous['code'], previous['result']
        code, result = operation()
        if 200 <= code < 300:
            receipts[identity] = {'fingerprint': fingerprint, 'code': code, 'result': result}
            write_json(path, receipts)
        return code, result


@contextmanager
def transaction() -> Iterator[None]:
    """旧文件先持久化再变更真源；异常立即回滚，进程中断由启动恢复处理。"""
    with LOCK:
        if getattr(_state, 'undo', None) is not None:
            yield
            return
        _recover_if_needed()
        _state.undo = {}
        _state.journal = storage_journal.Journal()
        _state.callbacks = []
        _state.rollbacks = []
        callbacks = []
        try:
            yield
            _state.journal.commit()
        except BaseException:
            recovered = True
            _state.journal.restore_files()
            for callback in reversed(_state.rollbacks):
                try:
                    callback()
                except Exception as error:
                    recovered = False
                    print(f"  [ STORAGE ] ⚠️ 外部恢复未完成，保留副本供重试 | External rollback pending: {error}")
            if recovered:
                _state.journal.discard()
            raise
        else:
            _state.journal.discard()
            callbacks = _state.callbacks
        finally:
            del _state.undo
            del _state.journal
            del _state.callbacks
            del _state.rollbacks
        for callback in callbacks:
            try:
                callback()
            except Exception as error:
                print(f"  [ STORAGE ] ⚠️ 提交后任务启动失败 | Post-commit task failed: {error}")


def transactional(function: Callable[P, R]) -> Callable[P, R]:
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        with transaction():
            return function(*args, **kwargs)
    return wrapped
