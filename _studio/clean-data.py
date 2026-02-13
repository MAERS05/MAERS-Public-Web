import os
import sqlite3
import re
import json
import shutil
from typing import Set
import config

# ================= 1. 助手函数 =================

def to_rel_path(full_path: str) -> str:
    """转换为相对于项目根目录的路径，并统一样式使用 /"""
    rel = os.path.relpath(full_path, config.PROJECT_ROOT)
    return rel.replace('\\', '/')

def normalize_path(path: str) -> str:
    """统一路径分隔符为 /"""
    if not path: return ""
    return path.replace('\\', '/')

class MaersJanitor:
    def __init__(self):
        self.used_files: Set[str] = set()
        self.deleted_files_count = 0
        self.db_fixes_count = 0

    def log(self, msg: str):
        print(f"[*] {msg}")

    def success(self, msg: str):
        print(f"[+] {msg}")

    def warn(self, msg: str):
        print(f"[!] {msg}")

    def collect_from_cms(self):
        """从 cms.db 收集所有被引用的图片"""
        if not os.path.exists(config.CMS_DB):
            self.warn("cms.db 不存在，跳过 CMS 扫描")
            return

        self.log("正在扫描 cms.db...")
        try:
            conn = sqlite3.connect(config.CMS_DB)
            cursor = conn.cursor()
            
            # 1. 扫描封面图
            cursor.execute("SELECT coverImage FROM nodes WHERE coverImage IS NOT NULL AND coverImage != ''")
            for row in cursor.fetchall():
                path = normalize_path(row[0])
                self.used_files.add(path)
                
                # Enhanced: Handle thumbnails/previews with extension change
                if path.startswith('photos/images/'):
                     # 1. Standard same-extension check (legacy)
                     self.used_files.add(path.replace('photos/images/', 'photos/thumbnails/'))
                     self.used_files.add(path.replace('photos/images/', 'photos/previews/'))
                     
                     # 2. Smart Extension Swap (for .webp/.avif generated files)
                     base_path_no_ext = os.path.splitext(path)[0]
                     
                     # Thumb -> .webp
                     thumb_path = base_path_no_ext.replace('photos/images/', 'photos/thumbnails/') + '.webp'
                     self.used_files.add(thumb_path)
                     
                     # Preview -> .avif
                     prev_path = base_path_no_ext.replace('photos/images/', 'photos/previews/') + '.avif'
                     self.used_files.add(prev_path)

            # 2. 扫描正文图片
            cursor.execute("SELECT content FROM nodes WHERE content IS NOT NULL AND content != ''")
            for row in cursor.fetchall():
                content = row[0]
                
                # New Logic: Handle MD files by reading their content
                if str(content).endswith('.md'):
                    # Add the MD file itself to whitelist
                    self.used_files.add(normalize_path(content))
                    
                    # Try to locate the MD file
                    # DB usually stores relative path like 'literature/foo.md'
                    full_md_path = os.path.join(config.DATA_DIR, content)
                    if not os.path.exists(full_md_path):
                        full_md_path = os.path.join(config.PROJECT_ROOT, content)
                        
                    if os.path.exists(full_md_path):
                        try:
                            with open(full_md_path, 'r', encoding='utf-8') as f:
                                file_content = f.read()
                                # recursively scan content of the MD file
                                matches = re.findall(r'photos/[^"\'\s)]+\.[\w]+', file_content)
                                for m in matches:
                                    path = normalize_path(m)
                                    self.used_files.add(path)
                                    if path.startswith('photos/images/'):
                                        # 1. Standard same-extension
                                        self.used_files.add(path.replace('photos/images/', 'photos/thumbnails/'))
                                        self.used_files.add(path.replace('photos/images/', 'photos/previews/'))
                                        # 2. Smart Extension Swap (.webp/.avif)
                                        base = os.path.splitext(path)[0]
                                        self.used_files.add(base.replace('photos/images/', 'photos/thumbnails/') + '.webp')
                                        self.used_files.add(base.replace('photos/images/', 'photos/previews/') + '.avif')
                        except Exception as e:
                            self.warn(f"Failed to parse MD file {content}: {e}")
                    continue

                # Standard text content scanning (for non-MD content nodes)
                matches = re.findall(r'photos/[^"\'\s)]+\.[\w]+', content)
                for m in matches:
                    path = normalize_path(m)
                    self.used_files.add(path)
                    if path.startswith('photos/images/'):
                        self.used_files.add(path.replace('photos/images/', 'photos/thumbnails/'))
                        self.used_files.add(path.replace('photos/images/', 'photos/previews/'))
                        # Smart Extension Swap for inline content too
                        base = os.path.splitext(path)[0]
                        self.used_files.add(base.replace('photos/images/', 'photos/thumbnails/') + '.webp')
                        self.used_files.add(base.replace('photos/images/', 'photos/previews/') + '.avif')
            
            conn.close()
        except Exception as e:
            self.warn(f"读取 cms.db 出错: {e}")

    def collect_from_gallery(self):
        """从 gallery.db 收集所有相册图片"""
        if not os.path.exists(config.GALLERY_DB):
            self.warn("gallery.db 不存在，跳过相册扫描")
            return

        self.log("正在扫描 gallery.db...")
        # Strict Cleanup Categories: These are considered "Attachment Folders"
        # If an image in these categories is NOT referenced in text/CMS, it should be deleted.
        ATTACHMENT_CATEGORIES = {'_notes', '_games', '_literature', '_record', 'default'}

        try:
            conn = sqlite3.connect(config.GALLERY_DB)
            cursor = conn.cursor()
            
            cursor.execute("SELECT path, thumb, preview, category FROM photos")
            for row in cursor.fetchall():
                path = normalize_path(row[0])
                thumb = normalize_path(row[1])
                preview = normalize_path(row[2])
                category = row[3]

                if category in ATTACHMENT_CATEGORIES:
                    # Check if ANY of the variants (Original, Thumb, Preview) is marked as USED
                    # Previous logic only checked 'path' (Original), causing deletion if MD referenced 'preview'
                    is_referenced = (path in self.used_files) or (thumb in self.used_files) or (preview in self.used_files)
                    
                    if not is_referenced:
                        # Log it for debugging (verbose)
                        # print(f"  [Clean] Unreferenced attachment found: {path}")
                        continue
                    
                    # If referenced, protect ALL variants
                    self.used_files.add(path)
                    self.used_files.add(thumb)
                    self.used_files.add(preview)
                else:
                    # For other categories (e.g. Photography, Life, Covers), 
                    # we treat Gallery DB as the source of truth (Standalone Album)
                    self.used_files.add(path)
                    self.used_files.add(thumb)
                    self.used_files.add(preview)
            
            conn.close()
        except Exception as e:
            self.warn(f"读取 gallery.db 出错: {e}")

    def collect_from_music(self):
        """扫描音乐配置文件中的潜在图片引用"""
        if not os.path.exists(config.MUSIC_DATA):
            return
        
        self.log("正在扫描 music-data.json...")
        try:
            with open(config.MUSIC_DATA, 'r', encoding='utf-8') as f:
                content = f.read()
                matches = re.findall(r'photos/[^"\'\s)]+\.[\w]+', content)
                for m in matches:
                    path = normalize_path(m)
                    self.used_files.add(path)
        except Exception as e:
            self.warn(f"读取 music-data.json 出错: {e}")

    def collect_from_space(self):
        """扫描 Space 配置文件中的本地图标引用"""
        if not os.path.exists(config.SPACE_DATA):
            return
        
        self.log("正在扫描 space-tree.json...")
        try:
            with open(config.SPACE_DATA, 'r', encoding='utf-8') as f:
                data = json.load(f)
                
            def scan_nodes(nodes):
                if not nodes:
                    return
                for node in nodes:
                    # 扫描图标字段
                    if 'icon' in node and node['icon']:
                        icon_path = node['icon']
                        # 只处理本地路径（不以 http:// 或 https:// 开头）
                        if not icon_path.startswith(('http://', 'https://')):
                            path = normalize_path(icon_path)
                            self.used_files.add(path)
                            # 如果是 photos 目录下的图标，也添加对应的缩略图
                            if path.startswith('photos/images/'):
                                self.used_files.add(path.replace('photos/images/', 'photos/thumbnails/'))
                                self.used_files.add(path.replace('photos/images/', 'photos/previews/'))
                    
                    # 递归扫描子节点
                    if 'children' in node and node['children']:
                        scan_nodes(node['children'])
            
            if 'root' in data:
                scan_nodes(data['root'])
                
        except Exception as e:
            self.warn(f"读取 space-tree.json 出错: {e}")

    def clean_physical_files(self):
        """遍历 photos 目录及其子目录，删除未被引用的文件"""
        self.log("正在清理物理文件 (photos/)...")
        if not os.path.exists(config.PHOTOS_ROOT): return

        image_dirs = ['images', 'thumbnails', 'previews']
        for root, dirs, files in os.walk(config.PHOTOS_ROOT):
            for file in files:
                if file.startswith('.'): continue
                
                full_path = os.path.join(root, file)
                rel_path = to_rel_path(full_path)
                
                if rel_path not in self.used_files:
                    is_core_asset = any(sub in rel_path for sub in image_dirs)
                    
                    if is_core_asset:
                        try:
                            os.remove(full_path)
                            self.deleted_files_count += 1
                        except Exception as e:
                            self.warn(f"删除失败: {rel_path} ({e})")

        # 新增: 正在清理物理 MD 文件 (data/模块/*.md)...
        self.log("正在清理物理 MD 文档 (data/模块/*.md)...")
        if os.path.exists(config.DATA_DIR):
            for item in os.listdir(config.DATA_DIR):
                sub_dir = os.path.join(config.DATA_DIR, item)
                if os.path.isdir(sub_dir):
                    for file in os.listdir(sub_dir):
                        if file.endswith('.md'):
                            full_path = os.path.join(sub_dir, file)
                            # 转换成相对于 PROJECT_ROOT 的路径，例如 'data/notes/xxx.md'
                            # 数据库里存的是 'notes/xxx.md'，但用于 clean-data 的 rel_path 逻辑通常包含完整相对路径
                            # 我们的 to_rel_path 会返回 'data/notes/xxx.md'
                            # 而我们数据库里存的是 'notes/xxx.md'。
                            # 需要统一下格式。
                            
                            rel_path = to_rel_path(full_path) 
                            # 如果 rel_path 是 "data/notes/xxx.md", 则数据库存的是 "notes/xxx.md"
                            db_ref_path = rel_path.replace('data/', '', 1) if rel_path.startswith('data/') else rel_path

                            if db_ref_path not in self.used_files:
                                try:
                                    os.remove(full_path)
                                    self.log(f"已删除孤立文档: {db_ref_path}")
                                    self.deleted_files_count += 1
                                except Exception as e:
                                    self.warn(f"删除文档失败: {db_ref_path} ({e})")

    def sanitize_databases(self):
        """清理数据库中的幽灵记录"""
        self.log("正在清理数据库无效记录...")
        
        # 1. Gallery DB
        if os.path.exists(config.GALLERY_DB):
            try:
                conn = sqlite3.connect(config.GALLERY_DB)
                cursor = conn.cursor()
                cursor.execute("SELECT id, path FROM photos")
                ghosts = []
                for row in cursor.fetchall():
                    pid, path = row[0], row[1]
                    if not os.path.exists(os.path.join(config.PROJECT_ROOT, path.replace('/', os.sep))):
                        ghosts.append(pid)
                
                for gid in ghosts:
                    cursor.execute("DELETE FROM photos WHERE id=?", (gid,))
                    self.db_fixes_count += 1
                
                conn.commit()
                conn.close()
            except Exception as e:
                self.warn(f"修复 gallery.db 出错: {e}")

        # 2. CMS DB
        if os.path.exists(config.CMS_DB):
            try:
                conn = sqlite3.connect(config.CMS_DB)
                cursor = conn.cursor()
                cursor.execute("SELECT id, coverImage FROM nodes WHERE coverImage IS NOT NULL AND coverImage != ''")
                ghosts = []
                for row in cursor.fetchall():
                    nid, cover = row[0], row[1]
                    if not os.path.exists(os.path.join(config.PROJECT_ROOT, cover.replace('/', os.sep))):
                        ghosts.append(nid)
                
                for nid in ghosts:
                    cursor.execute("UPDATE nodes SET coverImage = NULL WHERE id=?", (nid,))
                    self.db_fixes_count += 1
                
                # 新增: 检查 MD 文件
                cursor.execute("SELECT id, content FROM nodes WHERE content LIKE '%.md'")
                missing_docs = []
                for row in cursor.fetchall():
                    nid, rel_path = row[0], row[1]
                    abs_path = os.path.join(config.DATA_DIR, rel_path.replace('/', os.sep))
                    if not os.path.exists(abs_path):
                        missing_docs.append(nid)
                
                for nid in missing_docs:
                    cursor.execute("UPDATE nodes SET content = '' WHERE id=?", (nid,))
                    self.db_fixes_count += 1
                
                conn.commit()
                conn.close()
            except Exception as e:
                self.warn(f"修复 cms.db 出错: {e}")

    def remove_empty_dirs(self):
        """删除空的分类目录"""
        image_dirs = ['images', 'thumbnails', 'previews']
        for sub in image_dirs:
            base = os.path.join(config.PHOTOS_ROOT, sub)
            if not os.path.exists(base): continue
            
            for folder in os.listdir(base):
                if folder in ['_notes', '_games', '_literature', '_record', 'default']:
                    continue
                
                folder_path = os.path.join(base, folder)
                if not os.path.isdir(folder_path): continue
                
                if not os.listdir(folder_path):
                    try:
                        os.rmdir(folder_path)
                        self.log(f"移除了空目录: {to_rel_path(folder_path)}")
                    except:
                        pass

    def run(self):
        print("========================================")
        print("        扫 MAERS 全量垃圾清理工具")
        print("========================================")
        
        self.collect_from_cms()
        self.collect_from_gallery()
        self.collect_from_music()
        self.collect_from_space()
        # self.collect_from_games() # Removed: now covered by gallery/cms scanner
        
        total_refs = len(self.used_files)
        self.success(f"白名单构建完成，共计引用 {total_refs} 个有效路径")
        
        self.clean_physical_files()
        self.sanitize_databases()
        self.remove_empty_dirs()
        
        print("----------------------------------------")
        self.success(f"清理完成！")
        self.success(f"物理文件删除数量: {self.deleted_files_count}")
        self.success(f"数据库记录修正数: {self.db_fixes_count}")
        print("========================================")

if __name__ == '__main__':
    janitor = MaersJanitor()
    janitor.run()
