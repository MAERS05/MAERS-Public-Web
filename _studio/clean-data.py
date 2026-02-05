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
                # 同时也要把对应的 thumb/preview 加入（如果是 photos 里的）
                if path.startswith('photos/images/'):
                    self.used_files.add(path.replace('photos/images/', 'photos/thumbnails/'))
                    self.used_files.add(path.replace('photos/images/', 'photos/previews/'))

            # 2. 扫描正文图片
            cursor.execute("SELECT content FROM nodes WHERE content IS NOT NULL AND content != ''")
            for row in cursor.fetchall():
                content = row[0]
                matches = re.findall(r'photos/[^"\'\s)]+\.[\w]+', content)
                for m in matches:
                    path = normalize_path(m)
                    self.used_files.add(path)
                    if path.startswith('photos/images/'):
                        self.used_files.add(path.replace('photos/images/', 'photos/thumbnails/'))
                        self.used_files.add(path.replace('photos/images/', 'photos/previews/'))
            
            conn.close()
        except Exception as e:
            self.warn(f"读取 cms.db 出错: {e}")

    def collect_from_gallery(self):
        """从 gallery.db 收集所有相册图片"""
        if not os.path.exists(config.GALLERY_DB):
            self.warn("gallery.db 不存在，跳过相册扫描")
            return

        self.log("正在扫描 gallery.db...")
        try:
            conn = sqlite3.connect(config.GALLERY_DB)
            cursor = conn.cursor()
            
            cursor.execute("SELECT path, thumb, preview FROM photos")
            for row in cursor.fetchall():
                self.used_files.add(normalize_path(row[0]))
                self.used_files.add(normalize_path(row[1]))
                self.used_files.add(normalize_path(row[2]))
            
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
