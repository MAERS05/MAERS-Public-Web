"""本机长任务状态：进度读取独立于存储锁，退出服务前等待已经接收的任务。"""
import contextvars
import re
import secrets
import threading
import time
from contextlib import contextmanager

_current = contextvars.ContextVar('studio_operation', default=None)
_condition = threading.Condition()
_operations = {}


def start(identity=None):
    if identity is not None and not re.fullmatch(r'[0-9a-f]{32}', identity):
        raise ValueError('Invalid operation identity')
    identity = identity or secrets.token_hex(16)
    with _condition:
        expired = [key for key, value in _operations.items()
                   if value.get('finished_at', float('inf')) < time.time() - 600]
        for key in expired:
            del _operations[key]
        if _operations.get(identity, {}).get('state') == 'running':
            raise ValueError('Operation identity already used')
        _operations[identity] = {'state': 'running', 'message': '正在处理', 'done': 0, 'total': 0}
    return identity


@contextmanager
def bind(identity):
    token = _current.set(identity)
    try:
        yield
    finally:
        _current.reset(token)


def update(message, done=0, total=0, *, identity=None):
    with _condition:
        operation = _operations.get(identity or _current.get())
        if operation and operation['state'] == 'running':
            operation.update(message=message, done=done, total=total)


def finish(identity, success):
    with _condition:
        _operations[identity].update(state='success' if success else 'error', finished_at=time.time())
        _condition.notify_all()


def snapshot(identity):
    with _condition:
        operation = _operations.get(identity)
        return dict(operation) if operation else None


def active_count():
    with _condition:
        return sum(item['state'] == 'running' for item in _operations.values())


def running_progress():
    with _condition:
        running = [item for item in _operations.values() if item['state'] == 'running']
        visible = next((item for item in running if item['message'] != '正在处理'), None)
        source = visible or {'message': '正在等待已开始的操作完成', 'done': 0, 'total': 0}
        return {key: source[key] for key in ('message', 'done', 'total')}


def wait_for_idle():
    with _condition:
        _condition.wait_for(lambda: not active_count())
