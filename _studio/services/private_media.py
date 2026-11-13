"""私密媒体视图：会话 Cookie、允许读取的图片及响应地址，复用同一个会话状态。"""
import secrets
from urllib.parse import quote


class PrivateMedia:
    def __init__(self, state, decrypt):
        self.state = state
        self.decrypt = decrypt

    def cookie_header(self):
        return f'maers_private={self.state.media_cookie or ""}; HttpOnly; SameSite=Strict; Path=/api/private/media/'

    def authorized(self, header):
        from http.cookies import CookieError, SimpleCookie
        cookie = SimpleCookie()
        try:
            cookie.load(header or '')
            value = cookie.get('maers_private')
            return bool(self.state.keys and self.state.media_cookie and value and secrets.compare_digest(value.value, self.state.media_cookie))
        except (CookieError, ValueError, TypeError):
            return False

    def _media_fields(self, value):
        """图片三个尺寸共用字段过滤，保持原始媒体键。"""
        for field in ('path', 'thumb', 'preview'):
            key = value.get(field)
            if isinstance(key, str) and key.startswith('photos/'):
                yield key

    def register(self, value):
        if isinstance(value, dict):
            self.state.media.update(self._media_fields(value))
            for child in value.values():
                self.register(child)
        elif isinstance(value, list):
            for child in value:
                self.register(child)

    def _iter_keys(self, value, group):
        if isinstance(value, list):
            for child in value:
                yield from self._iter_keys(child, group)
            return
        if not isinstance(value, dict):
            return
        if value.get('_enc'):
            scope = value.get('_group', 'default')
            if scope == group and self.state.group_unlocked(scope):
                yield from self._iter_keys(self.decrypt(value['_enc'], scope), group)
            return
        yield from self._media_fields(value)
        for child in value.values():
            yield from self._iter_keys(child, group)

    def keys(self, value, group=None):
        """只收集明文和指定已解锁组的媒体，不跨密码组还原后代。"""
        return sorted(set(self._iter_keys(value, group)))

    def url(self, key):
        return '/api/private/media/' + '/'.join(quote(part, safe='') for part in key.split('/'))

    def read(self, key):
        from . import local_media, media_store
        if not self.state.active() or key not in self.state.media:
            raise ValueError('Private media is not available')
        store = media_store.get_store()
        path = local_media.path(key)
        if path.is_file():
            return path.read_bytes()
        data = store.read('private', key)
        local_media.keep(key, data)
        local_media.set_private([key])
        return data

    def view(self, value):
        """只转换响应中的媒体地址；工作记录始终保留真实文件键。"""
        if isinstance(value, list):
            return [self.view(child) for child in value]
        if not isinstance(value, dict):
            return value
        result = {key: self.view(child) for key, child in value.items()}
        for field in ('path', 'thumb', 'preview', 'coverImage', 'coverThumb', 'coverPreview'):
            if isinstance(result.get(field), str) and result[field] in self.state.media:
                result[field] = self.url(result[field])
        if isinstance(value.get('coverRow'), dict):
            row = value['coverRow']
            result['coverPreview'] = self.url(row.get('preview') or row['path'])
            result['coverThumb'] = self.url(row.get('thumb') or row['path'])
        return result
