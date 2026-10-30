"""历史媒体同步入口：通过统一存储适配上传公开索引原图，支持备份、校验与恢复。"""

import argparse
import json
import os
import sys
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parents[1]
if str(STUDIO_DIR) not in sys.path:
    sys.path.insert(0, str(STUDIO_DIR))

import config
from services import media_jobs, media_store, data_safety, storage, storage_journal


def main(argv=None):
    parser = argparse.ArgumentParser(description='媒体同步与数据保障（兼容原 R2 工具入口）')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--backup', action='store_true', help='创建包含公私媒体的完整备份')
    actions.add_argument('--verify', metavar='ID', help='校验备份')
    actions.add_argument('--restore', metavar='ID', help='恢复备份，操作前自动备份当前状态')
    actions.add_argument('--retry', action='store_true', help='重试持久化同步待办')
    args = parser.parse_args(argv)
    # 服务运行时不允许另一个进程同步，防止加锁后被旧上传重新公开。
    with storage_journal.process_lock():
        storage.recover()
        if args.backup:
            result = data_safety.create_backup()
        elif args.verify:
            result = data_safety.verify_backup(args.verify)
        elif args.restore:
            result = data_safety.restore_backup(args.restore)
        elif args.retry:
            result = media_jobs.retry()
        else:
            path = Path(config.DATA_DIR) / 'photos-data.json'
            with path.open(encoding='utf-8') as source:
                gallery = json.load(source)
            from services.photos import media_path
            store = media_store.get_store()
            count = 0
            for rows in gallery.values():
                for row in rows:
                    key = row['path']
                    local = media_path(key)
                    if not os.path.isfile(local):
                        if not store.exists('public', key):
                            raise FileNotFoundError('公开索引原图在本机和远端均缺失，已停止同步')
                        continue
                    media_jobs.enqueue('upload', key)
                    count += 1
            result = {**media_jobs.retry(), 'queued': count}
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result.get('state') == 'pending' else 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
