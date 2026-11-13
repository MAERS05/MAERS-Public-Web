"""图库索引：JSON 真源校验、可重建 SQLite 缓存和事务内的索引发布。"""
import json
import os
import sqlite3
from contextlib import closing
from . import storage

def top_order(connection, category):
    minimum = connection.execute("SELECT MIN(sort_order) FROM photos WHERE category=?", (category,)).fetchone()[0]
    return (minimum if minimum is not None else 0) - 1


class GalleryStore:
    """路径由入口注入，生产配置与测试沙盒共用同一套索引实现。"""

    def __init__(self, database_path, source_path, media_path):
        self.database_path = database_path
        self.source_path = source_path
        self.media_path = media_path

    def _cache_record(self, category, order, row):
        """将真源中的单张图片校验并转换为缓存行。"""
        for field in ('path', 'thumb', 'preview'):
            if row.get(field):
                self.media_path(row[field])
        return (row['id'], category, row['name'], row['path'], row.get('thumb', ''),
                row.get('preview', ''), row.get('hash', ''), row.get('created_at', 0), order,
                json.dumps(row.get('tags', []), ensure_ascii=False), row.get('bucketId', ''))

    @storage.serialized
    def rebuild_cache(self) -> None:
        """photos-data.json 是图库索引真源；替换式重建丢失、损坏或过期的缓存。"""
        import tempfile
        data = {}
        if os.path.exists(self.source_path()):
            with open(self.source_path(), encoding='utf-8') as source:
                data = json.load(source)
        if not isinstance(data, dict) or any(not isinstance(rows, list) for rows in data.values()):
            raise ValueError('Invalid gallery source')
        os.makedirs(os.path.dirname(self.database_path()), exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.gallery-cache-', suffix='.db', dir=os.path.dirname(self.database_path()))
        os.close(fd)
        try:
            with closing(sqlite3.connect(temporary)) as connection, connection:
                connection.execute('''CREATE TABLE photos (id TEXT PRIMARY KEY, category TEXT, name TEXT,
                    path TEXT, thumb TEXT, preview TEXT, hash TEXT, created_at REAL, sort_order INTEGER, tags TEXT,
                    bucket_id TEXT NOT NULL DEFAULT '')''')
                records = (self._cache_record(category, order, row)
                           for category, rows in data.items() for order, row in enumerate(rows))
                connection.executemany('INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', records)
            os.replace(temporary, self.database_path())
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)

    def get_db(self):
        if not os.path.exists(self.database_path()):
            self.rebuild_cache()
        connection = sqlite3.connect(self.database_path())
        connection.row_factory = sqlite3.Row
        return connection

    @storage.serialized
    def sync_gallery_js(self) -> None:
        """从数据库生成静态 JSON 数据供前端读取"""
        with closing(self.get_db()) as connection:
            rows = connection.execute("SELECT * FROM photos ORDER BY sort_order ASC").fetchall()

        data = {}
        for row in rows:
            cat = row['category']

            item = {
                "id": row['id'],
                "path": row['path'],
                "name": row['name'],
                "thumb": row['thumb'],
                "preview": row['preview'],
                "hash": row['hash'],
                "created_at": row['created_at'],
                "tags": json.loads(row['tags']) if row['tags'] else []
            }
            if row['bucket_id']:
                item['bucketId'] = row['bucket_id']
            data.setdefault(cat, []).append(item)

        storage.write_json(self.source_path(), data)
