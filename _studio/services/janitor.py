# -*- coding: utf-8 -*-
"""
MAERS 垃圾数据清理服务 (_studio/services/janitor.py)
职责：
1. 扫描 CMS (*-tree.json)、相册 (photos-data.json 重建的缓存)、音乐 (music-data.json)、空间 (space-tree.json) 中被引用的有效资源路径；
2. 清理 photos/ 下未被任何 Markdown 正文、节点封面或独立相册引用的孤立图片（含原图、webp 缩略图、avif 预览图）；
3. 清理 data/<module>/ 下未被 JSON 节点引用的孤立 .md 文档；
4. 清理数据库中的幽灵记录（指向已不存在本地文件的记录）及空目录，并同步刷新静态 JSON。
"""

import os
import json
import sqlite3
from . import storage, data_safety
import uuid
from typing import Set, List, Dict, Any
import config
from services import photos, cms


def to_rel_path(full_path: str) -> str:
    """转换为相对于项目根目录的路径，并统一使用 / 分隔符"""
    rel = os.path.relpath(full_path, config.PROJECT_ROOT)
    return rel.replace("\\", "/")


def normalize_path(path: str) -> str:
    """真实文件路径只统一分隔符，保留文件名中的 #、% 及其他字面字符。"""
    if not path:
        return ""
    return path.replace('\\', '/')


class MaersJanitor:
    def __init__(self):
        self.batch = uuid.uuid4().hex
        self.used_files: Set[str] = set()
        self.legacy_locked_media = False
        self.deleted_files_count = 0
        self.deleted_files: List[str] = []
        self.db_fixes_count = 0
        self.removed_dirs_count = 0

    def _add_photo_variants(self, path: str, *, is_url=False):
        """将图片路径及其对应的 thumbnails (.webp) 和 previews (.avif) 变体一并加入白名单"""
        path = photos.normalize_media_reference(path) if is_url else normalize_path(path)
        if not path:
            return
        self.used_files.add(path)

        for prefix in ("photos/images/", "photos/thumbnails/", "photos/previews/"):
            if path.startswith(prefix):
                base_no_ext = os.path.splitext(path)[0]
                rel_tail = path[len(prefix):]
                rel_tail_no_ext = base_no_ext[len(prefix):]
                # 同后缀变体
                self.used_files.add("photos/images/" + rel_tail)
                self.used_files.add("photos/thumbnails/" + rel_tail)
                self.used_files.add("photos/previews/" + rel_tail)
                # 智能后缀变体 (.webp / .avif)
                self.used_files.add("photos/thumbnails/" + rel_tail_no_ext + ".webp")
                self.used_files.add("photos/previews/" + rel_tail_no_ext + ".avif")
                break

    def _collect_config_media(self, value):
        """索引/配置中的本地图片键是文件路径，明确的远程地址或正文链接才按 URL 解码。"""
        if isinstance(value, dict):
            for child in value.values():
                self._collect_config_media(child)
        elif isinstance(value, list):
            for child in value:
                self._collect_config_media(child)
        elif isinstance(value, str):
            if value.startswith(('http://', 'https://', '//')):
                self._add_photo_variants(value, is_url=True)
            elif normalize_path(value).startswith('photos/'):
                self._add_photo_variants(value)
            else:
                for reference in photos.media_references(value):
                    self._add_photo_variants(reference, is_url=True)

    def collect_from_cms(self):
        """只从 JSON 真源收集引用；损坏的索引必须中止清理，不能当作空数据。"""
        from . import cms, cms_store
        for module in cms.JS_SYNC_MAP:
            for node in cms_store.walk(cms.fetch_module_tree(module)['root']):
                self._collect_config_media(node.get('coverImage'))
                if node.get('_enc'):
                    if node.get('mediaVersion') != 1:
                        self.legacy_locked_media = True
                    continue
                content = str(node.get('content') or '')
                if content.endswith('.md'):
                    self.used_files.add(normalize_path(content))
                    path = os.path.join(config.DATA_DIR, content)
                    if os.path.isfile(path):
                        with open(path, encoding='utf-8') as source:
                            content = source.read()
                for match in photos.media_references(content):
                    self._add_photo_variants(match, is_url=True)
        tags_dir = os.path.join(config.DATA_DIR, 'tags')
        if os.path.isdir(tags_dir):
            for name in os.listdir(tags_dir):
                if name.endswith('.json'):
                    with open(os.path.join(tags_dir, name), encoding='utf-8') as source:
                        self._collect_config_media(json.load(source))

    def collect_from_gallery(self):
        """从 gallery.db 收集所有相册图片"""
        if not os.path.exists(config.GALLERY_DB):
            return

        # 附件分类：必须被 CMS / Markdown 正文或封面引用才保留；独立相册分类则直接保留
        attachment_categories = {"_notes", "_games", "_literature", "_record", "default", "_videos"}

        try:
            conn = sqlite3.connect(config.GALLERY_DB)
            cursor = conn.cursor()
            cursor.execute("SELECT path, thumb, preview, category FROM photos")
            for row in cursor.fetchall():
                path = normalize_path(row[0])
                thumb = normalize_path(row[1])
                preview = normalize_path(row[2])
                category = row[3]

                if category in attachment_categories and not self.legacy_locked_media:
                    is_referenced = (
                        (path in self.used_files)
                        or (thumb in self.used_files)
                        or (preview in self.used_files)
                    )
                    if not is_referenced:
                        continue

                for p in (path, thumb, preview):
                    if p:
                        self.used_files.add(p)

            conn.close()
        except (OSError, ValueError, sqlite3.Error) as e:
            print(f"  [ JANITOR ] ⚠️ 读取 gallery.db 出错 | Error reading gallery.db: {e}")
            raise

    def collect_from_music(self):
        """扫描音乐配置文件中的潜在图片引用"""
        if not os.path.exists(config.MUSIC_DATA):
            return
        try:
            with open(config.MUSIC_DATA, "r", encoding="utf-8") as f:
                content = f.read()
            self._collect_config_media(json.loads(content))
        except (OSError, ValueError, sqlite3.Error) as e:
            print(f"  [ JANITOR ] ⚠️ 读取 music-data.json 出错 | Error: {e}")
            raise

    def collect_from_space(self):
        """扫描 Space 配置文件中的本地图标引用"""
        if not os.path.exists(config.SPACE_DATA):
            return
        try:
            with open(config.SPACE_DATA, "r", encoding="utf-8") as f:
                data = json.load(f)

            def scan_nodes(nodes):
                if not isinstance(nodes, list):
                    return
                for node in nodes:
                    if not isinstance(node, dict):
                        continue
                    icon_path = node.get("icon")
                    if icon_path:
                        self._collect_config_media(str(icon_path))
                    if node.get("children"):
                        scan_nodes(node["children"])

            from . import validation
            validation.tree(data)
            scan_nodes(data["root"])
        except (OSError, ValueError, sqlite3.Error) as e:
            print(f"  [ JANITOR ] ⚠️ 读取 space-tree.json 出错 | Error: {e}")
            raise

    def clean_physical_files(self):
        """遍历 photos/ 与 data/<module>/，删除未被引用的孤立图片与孤立 .md 文档"""
        if os.path.exists(config.PHOTOS_ROOT) and not self.legacy_locked_media:
            image_dirs = ("images", "thumbnails", "previews")
            for root, _, files in os.walk(config.PHOTOS_ROOT):
                for file in files:
                    if file.startswith("."):
                        continue
                    full_path = os.path.join(root, file)
                    rel_path = to_rel_path(full_path)
                    if rel_path not in self.used_files and any(sub in rel_path for sub in image_dirs):
                        try:
                            data_safety.quarantine(full_path, self.batch)
                            self.deleted_files_count += 1
                            self.deleted_files.append(rel_path)
                        except (OSError, ValueError, sqlite3.Error) as e:
                            print(f"  [ JANITOR ] ⚠️ 删除文件失败 | Failed to delete {rel_path}: {e}")

        if os.path.exists(config.DATA_DIR):
            for item in os.listdir(config.DATA_DIR):
                sub_dir = os.path.join(config.DATA_DIR, item)
                if not os.path.isdir(sub_dir) or item == "tags":
                    continue
                for file in os.listdir(sub_dir):
                    if not file.endswith(".md"):
                        continue
                    full_path = os.path.join(sub_dir, file)
                    rel_path = to_rel_path(full_path)
                    db_ref_path = rel_path[5:] if rel_path.startswith("data/") else rel_path
                    if db_ref_path not in self.used_files and rel_path not in self.used_files:
                        try:
                            data_safety.quarantine(full_path, self.batch)
                            self.deleted_files_count += 1
                            self.deleted_files.append(rel_path)
                        except (OSError, ValueError, sqlite3.Error) as e:
                            print(f"  [ JANITOR ] ⚠️ 删除文档失败 | Failed to delete {rel_path}: {e}")

    def sanitize_databases(self):
        """清理数据库中的幽灵记录（注意兼容原图已迁移 R2、本地仅保留缩略图/预览图的情况）"""
        # 本地缺图可能仅表示原图在远端，绝不能据此删掉图库真源记录。
        photos.rebuild_cache()

        # CMS 缓存不接受独立修正；正文缺失不会反向清空 JSON 真源中的路径。
        from . import cms
        cms.rebuild_cache()

    def remove_empty_dirs(self):
        """删除空的非系统分类目录"""
        protected = {"_notes", "_games", "_literature", "_record", "default", "_videos", "videocovers"}
        for sub in ("images", "thumbnails", "previews"):
            base = os.path.join(config.PHOTOS_ROOT, sub)
            if not os.path.exists(base):
                continue
            for folder in os.listdir(base):
                if folder in protected:
                    continue
                folder_path = os.path.join(base, folder)
                if os.path.isdir(folder_path) and not os.listdir(folder_path):
                    try:
                        os.rmdir(folder_path)
                        self.removed_dirs_count += 1
                    except OSError:
                        pass

    def run(self) -> Dict[str, Any]:
        print("  [ JANITOR ] 🧹 开始执行全量垃圾清理 | Starting full data cleanup...")
        data_safety.preflight_cleanup()
        photos.rebuild_cache()
        self.collect_from_cms()
        self.collect_from_gallery()
        self.collect_from_music()
        self.collect_from_space()

        self.clean_physical_files()
        self.sanitize_databases()
        self.remove_empty_dirs()

        # 同步刷新相册 JSON 数据
        try:
            photos.sync_gallery_js()
        except (OSError, ValueError, sqlite3.Error) as e:
            print(f"  [ JANITOR ] ⚠️ 同步相册 JSON 失败 | Failed to sync gallery JSON: {e}")
            raise

        print(
            f"  [ JANITOR ] ✅ 清理完成：删除 {self.deleted_files_count} 个孤立文件，"
            f"修正 {self.db_fixes_count} 条数据库记录 | Cleanup finished"
        )
        return {
            "success": True,
            "quarantine_batch": self.batch,
            "referenced_count": len(self.used_files),
            "deleted_files_count": self.deleted_files_count,
            "deleted_files": self.deleted_files[:50],
            "db_fixes_count": self.db_fixes_count,
            "removed_dirs_count": self.removed_dirs_count,
        }


@storage.transactional
def run_cleanup() -> Dict[str, Any]:
    janitor = MaersJanitor()
    return janitor.run()

