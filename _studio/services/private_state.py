"""私密管理会话状态：鉴权上下文、密钥与明文工作区由单一实例持有和清除。"""
import contextvars
from dataclasses import dataclass, field


@dataclass
class PrivateState:
    authorized: contextvars.ContextVar = field(default_factory=lambda: contextvars.ContextVar('private_admin', default=False))
    keys: dict = field(default_factory=dict)
    lease: str | None = None
    media_cookie: str | None = None
    decoded: dict = field(default_factory=dict)
    references: dict = field(default_factory=dict)
    documents: dict = field(default_factory=dict)
    dirty_documents: set = field(default_factory=set)
    albums: dict = field(default_factory=dict)
    media: set = field(default_factory=set)

    def active(self):
        return bool(self.keys and self.authorized.get())

    def group_unlocked(self, group='default'):
        return bool(self.authorized.get() and group in self.keys)

    def clear(self):
        self.lease = self.media_cookie = None
        for cache in (self.keys, self.decoded, self.references, self.documents, self.albums):
            cache.clear()
        self.media.clear()
        self.dirty_documents.clear()
