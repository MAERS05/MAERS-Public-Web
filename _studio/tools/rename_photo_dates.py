"""按 EXIF 校正存量图片名：先备份和复制，再更新引用，发布后单独清理旧路径。"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import config
from services import local_crypto_access, local_media, media_groups, media_store, photo_images, photo_paths
from services import photos, private_session, storage, storage_journal
from botocore.exceptions import ClientError

ROOT = Path(config.PROJECT_ROOT).resolve()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inside(path, boundary=ROOT):
    path = Path(path).absolute()
    resolved = path.resolve()
    if not resolved.is_relative_to(boundary.resolve()) or resolved != path:
        raise ValueError('迁移路径越界或包含目录联接')
    return path


def save_plan(path, plan):
    storage_journal.atomic(str(path), (json.dumps(plan, ensure_ascii=False, indent=2) + '\n').encode())


def sources():
    files = set(ROOT.glob('*.html'))
    for folder, suffixes in [('data', {'.json'}), ('markdown', {'.md'}), ('custom', {'.js', '.css', '.json', '.html'}),
                             ('shared', {'.js'}), ('static-style', {'.css'})]:
        files.update(p for p in (ROOT / folder).rglob('*') if p.is_file() and p.suffix in suffixes and not p.name.startswith('.'))
    files.add(ROOT / '_studio/.local/private-photo-keys.json')
    return sorted(inside(p) for p in files if p.is_file())


def opened(value):
    if isinstance(value, dict):
        if isinstance(value.get('_enc'), str):
            yield from opened(private_session.decrypt(value['_enc'], value.get('_group', 'default')))
        else:
            yield value
            for child in value.values():
                yield from opened(child)
    elif isinstance(value, list):
        for child in value:
            yield from opened(child)


def replace_references(value, mapping, pattern):
    replace = lambda text: pattern.sub(lambda match: mapping[match[0]], text)
    if isinstance(value, str):
        return replace(value)
    if isinstance(value, list):
        return [replace_references(child, mapping, pattern) for child in value]
    if not isinstance(value, dict):
        return value
    result = copy.deepcopy(value)
    if isinstance(value.get('_enc'), str):
        group = value.get('_group', 'default')
        plain = private_session.decrypt(value['_enc'], group)
        updated = replace_references(plain, mapping, pattern)
        if updated != plain:
            result['_enc'] = private_session.encrypt(updated, group)
    for key, child in value.items():
        if key not in ('_enc', 'id', 'tags', 'created_at', 'sort_order', 'hash'):
            result[key] = replace_references(child, mapping, pattern)
    old_path = photo_paths.normalize_media_reference(value.get('path', ''))
    if old_path in mapping and value.get('name') == old_path.rsplit('/', 1)[-1]:
        result['name'] = mapping[old_path].rsplit('/', 1)[-1]
    return result


def head(client, bucket, key):
    try:
        return client.head_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
            return None
        raise


def build_plan(store):
    directory = inside(Path(storage_journal.local_root()) / 'backups' / ('photo-dates-' + uuid.uuid4().hex))
    directory.mkdir(parents=True)
    candidates = sources()
    snapshots = {p.relative_to(ROOT).as_posix(): digest(p.read_bytes()) for p in candidates}
    rows = {}
    for p in candidates:
        if p.suffix == '.json':
            for row in opened(json.loads(p.read_text(encoding='utf-8-sig'))):
                if isinstance(row.get('path'), str) and row['path'].startswith('photos/images/'):
                    rows[row['path']] = row
    cloud = {scope: set(store.keys(scope)) for scope in ('public', 'private')}
    private = local_media.private_keys()
    originals = {key: path for key, path in local_media.files(ROOT) if key.startswith('photos/images/')}
    missing = {key for keys in cloud.values() for key in keys if key.startswith('photos/images/')} - originals.keys()
    # 云端独有原图也参与核对，恢复材料只写在忽略发布的备份目录中。
    for key in sorted(missing):
        photo_paths.media_parts(key)
        scope = 'private' if key in cloud['private'] else 'public'
        target = inside(directory / 'files' / key, directory)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(store.read(scope, key))
        originals[key] = target
    changes, mapping = [], {}
    for key, original in originals.items():
        info = photo_images.get_exif_datetime(original)
        if not info:
            continue
        import time
        label = time.strftime('%Y%m%d_%H%M%S', info[0])
        stem, extension = os.path.splitext(original.name)
        if stem.startswith(label + '_'):
            continue
        suffix = re.fullmatch(r'\d{8}_\d{6}_([0-9a-fA-F]{32})', stem)
        identity = suffix[1] if suffix else hashlib.sha256(key.encode()).hexdigest()[:32]
        name = f'{label}_{identity}'
        category = key.split('/')[2]
        selected = {'path': key, **{field: rows.get(key, {}).get(field) for field in ('thumb', 'preview')}}
        for field, folder, ext in [('path', 'images', extension), ('thumb', 'thumbnails', '.webp'), ('preview', 'previews', '.avif')]:
            old = selected.get(field) or f'photos/{folder}/{category}/{stem}{ext}'
            if old in mapping:
                continue
            local = local_media.path(old)
            scope = 'private' if local_media.is_private(key, private) or key in cloud['private'] else 'public'
            if scope == 'private' and old in cloud['public']:
                raise ValueError('私密图片仍有公开副本，迁移已停止')
            if not local.is_file() and old not in cloud[scope]:
                if selected.get(field):
                    raise FileNotFoundError('图片索引引用的文件缺失：' + old)
                continue
            new = f'photos/{folder}/{category}/{name}{Path(old).suffix}'
            photo_paths.media_parts(new)
            if new in mapping.values():
                raise ValueError('目标图片名冲突')
            backup = inside(directory / 'files' / old, directory)
            backup.parent.mkdir(parents=True, exist_ok=True)
            if not backup.is_file():
                if local.is_file():
                    shutil.copy2(local, backup)
                else:
                    backup.write_bytes(store.read(scope, old))
            data = backup.read_bytes()
            if local_media.path(new).exists() and digest(local_media.path(new).read_bytes()) != digest(data):
                raise ValueError('本机目标路径已存在不同内容')
            mapping[old] = new
            changes.append({'old': old, 'new': new, 'scope': scope, 'bytes': len(data), 'sha256': digest(data),
                            'md5': hashlib.md5(data).hexdigest(), 'remote': old in cloud[scope]})
    pattern = re.compile('|'.join(re.escape(key) for key in sorted(mapping, key=len, reverse=True))) if mapping else None
    updated = []
    if pattern:
        for p in candidates:
            original = p.read_bytes()
            if p.suffix == '.json':
                value = json.loads(original.decode('utf-8-sig'))
                changed = replace_references(value, mapping, pattern)
                result = (json.dumps(changed, ensure_ascii=False, indent=2) + '\n').encode() if changed != value else original
            else:
                text = original.decode('utf-8-sig')
                changed = pattern.sub(lambda match: mapping[match[0]], text)
                result = changed.encode() if changed != text else original
            if result == original:
                continue
            relative = p.relative_to(ROOT).as_posix()
            for folder, data in [('before', original), ('after', result)]:
                backup = inside(directory / folder / relative, directory)
                backup.parent.mkdir(parents=True, exist_ok=True)
                backup.write_bytes(data)
            updated.append(relative)
    plan = {'v': 1, 'root': str(ROOT), 'backend': store.identity(), 'phase': 'planned', 'snapshots': snapshots,
            'files': changes, 'metadata': updated, 'cloud_only_originals': len(missing)}
    path = directory / 'plan.json'
    save_plan(path, plan)
    return path, plan


def verify_local(plan):
    for row in plan['files']:
        path = local_media.path(row['new'])
        if not path.is_file() or digest(path.read_bytes()) != row['sha256']:
            raise ValueError('本机目标图片校验失败')


def migrated_policy(data, old, new):
    value = json.loads(data)
    if value.get('key') != old or not isinstance(value.get('groups'), list):
        raise ValueError('私密图片权限记录与原路径不符')
    value['key'] = new
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def apply_plan(path, plan, store):
    directory = path.parent
    if plan['phase'] == 'applied':
        verify_local(plan)
        def verify_policy(row):
            if row['scope'] != 'private':
                return
            original = (directory / 'policies' / media_groups.policy_key(row['old'])).read_bytes()
            updated = migrated_policy(original, row['old'], row['new'])
            current = store.read_policy(media_groups.policy_key(row['new']))
            if current not in (original, updated):
                raise ValueError('迁移后权限记录已被其他操作修改')
            if current != updated:
                store.write_policy(media_groups.policy_key(row['new']), updated)
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(verify_policy, plan['files']))
        return
    if plan['phase'] != 'planned':
        raise ValueError('迁移状态不允许执行')
    if {p.relative_to(ROOT).as_posix() for p in sources()} != set(plan['snapshots']):
        raise ValueError('本机文件集合已变化，请重新生成清单')
    for relative, expected in plan['snapshots'].items():
        if digest(inside(ROOT / relative).read_bytes()) != expected:
            raise ValueError('清单生成后有本机编辑，请重新生成清单：' + relative)
    known_routes = set(store._list_keys('private', '_maers/photo-buckets/'))

    def stage(row):
        old, new, scope = row['old'], row['new'], row['scope']
        backup = inside(directory / 'files' / old, directory)
        data = backup.read_bytes()
        if digest(data) != row['sha256']:
            raise ValueError('备份内容已变化')
        bucket_id = store.bucket_id(old) if media_store._route_key(old) in known_routes else media_store.DEFAULT_BUCKET
        assigned = store._group(bucket_id)
        client, bucket = assigned._client_for(scope), assigned._bucket(scope)
        target = head(client, bucket, new)
        if row['remote']:
            original = head(client, bucket, old)
            if original is None or original['ContentLength'] != len(data):
                raise ValueError('云端原图与本机备份不一致')
            if original['ETag'].strip('"') != row['md5'] and digest(store.read(scope, old)) != row['sha256']:
                raise ValueError('云端原图校验失败')
            if target is None:
                client.copy_object(Bucket=bucket, Key=new, CopySource={'Bucket': bucket, 'Key': old},
                                   CopySourceIfMatch=original['ETag'], MetadataDirective='COPY')
                target = head(client, bucket, new)
            if target['ContentLength'] != original['ContentLength'] or target['ETag'] != original['ETag']:
                raise ValueError('云端复制校验失败')
            row['etag'] = original['ETag']
        elif target is None:
            client.put_object(Bucket=bucket, Key=new, Body=data,
                              ContentType=__import__('mimetypes').guess_type(new)[0] or 'application/octet-stream')
            target = head(client, bucket, new)
            if target['ContentLength'] != len(data) or digest(assigned.read(scope, new)) != row['sha256']:
                raise ValueError('云端补传校验失败')
        elif target['ContentLength'] != len(data) or digest(assigned.read(scope, new)) != row['sha256']:
            raise ValueError('云端目标已存在不同内容')
        if bucket_id != media_store.DEFAULT_BUCKET:
            store.claim_bucket(new, bucket_id)
        if scope == 'private':
            policy = store.read_policy(media_groups.policy_key(old))
            if policy is None:
                raise ValueError('私密图片缺少权限记录')
            policy_backup = inside(directory / 'policies' / media_groups.policy_key(old), directory)
            policy_backup.parent.mkdir(parents=True, exist_ok=True)
            if policy_backup.exists() and policy_backup.read_bytes() != policy:
                raise ValueError('原权限记录在迁移中已变化')
            policy_backup.write_bytes(policy)
            store.write_policy(media_groups.policy_key(new), migrated_policy(policy, old, new))
        local = local_media.path(new)
        local.parent.mkdir(parents=True, exist_ok=True)
        if not local.exists():
            shutil.copy2(backup, local)
        row['bucketId'] = bucket_id
        return row

    completed = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        for future in as_completed([pool.submit(stage, row) for row in plan['files']]):
            future.result()
            completed += 1
            if completed % 30 == 0 or completed == len(plan['files']):
                print(f'Copied and verified {completed}/{len(plan["files"])}', flush=True)
    verify_local(plan)
    with storage.transaction():
        for relative in plan['metadata']:
            storage.write_bytes(str(inside(ROOT / relative)), inside(directory / 'after' / relative, directory).read_bytes())
    photos.rebuild_cache()
    plan['phase'] = 'applied'
    save_plan(path, plan)


def cleanup(path, plan, store):
    if plan['phase'] != 'applied':
        raise ValueError('请先完成迁移并发布新索引，再清理旧路径')
    verify_local(plan)
    for relative in plan['metadata']:
        if (ROOT / relative).read_bytes() != (path.parent / 'after' / relative).read_bytes():
            raise ValueError('迁移后的引用又有变化，请先核对再清理')
    def retire(row):
        assigned = store._group(row['bucketId'])
        client, bucket = assigned._client_for(row['scope']), assigned._bucket(row['scope'])
        target = head(client, bucket, row['new'])
        if (target is None or target['ContentLength'] != row['bytes'] or
                row.get('etag') and target['ETag'] != row['etag']):
            raise ValueError('清理前目标对象校验失败')
        old_policy = None
        if row['scope'] == 'private':
            before = (path.parent / 'policies' / media_groups.policy_key(row['old'])).read_bytes()
            old_policy = store.read_policy(media_groups.policy_key(row['old']))
            updated = migrated_policy(before, row['old'], row['new'])
            if (old_policy is not None and old_policy != before or
                    store.read_policy(media_groups.policy_key(row['new'])) != updated):
                raise ValueError('图片权限记录在迁移后已变化')
        local = local_media.path(row['old'])
        if local.exists() and digest(local.read_bytes()) != row['sha256']:
            raise ValueError('本机旧文件在迁移后又被修改')
        original = head(client, bucket, row['old'])
        if original:
            if not row['remote']:
                raise ValueError('清单生成后旧路径新增了云端对象，请先核对')
            if row.get('etag') and original['ETag'] != row['etag']:
                raise ValueError('云端旧对象已被其他修改更新')
            # B2 创建隐藏标记，保留历史版本作为恢复来源，不永久清除历史内容。
            client.delete_object(Bucket=bucket, Key=row['old'])
        if old_policy is not None:
            store.delete_policy(media_groups.policy_key(row['old']))
        if local.exists():
            local.unlink()
    with ThreadPoolExecutor(max_workers=6) as pool:
        for index, future in enumerate(as_completed([pool.submit(retire, row) for row in plan['files']]), 1):
            future.result()
            if index % 30 == 0 or index == len(plan['files']):
                print(f'Retired old paths {index}/{len(plan["files"])}', flush=True)
    plan['phase'] = 'complete'
    save_plan(path, plan)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--apply', action='store_true')
    actions.add_argument('--cleanup', action='store_true')
    args = parser.parse_args()
    if (args.apply or args.cleanup) and not args.plan:
        parser.error('执行迁移或清理必须指定已核对的 --plan')
    code, result = local_crypto_access.open_session()
    if code != 200:
        raise PermissionError(result.get('error', '请先登记本机管理权限'))
    try:
        with private_session.context():
            store = media_store.get_store()
            if args.plan:
                path = inside(args.plan, Path(storage_journal.local_root()) / 'backups')
                plan = json.loads(path.read_text(encoding='utf-8'))
            else:
                path, plan = build_plan(store)
            if plan['root'] != str(ROOT) or plan['backend'] != store.identity():
                raise ValueError('清单与当前项目或存储配置不一致')
            if args.apply or args.cleanup:
                with storage_journal.process_lock():
                    (cleanup if args.cleanup else apply_plan)(path, plan, store)
            print(json.dumps({'plan': str(path), 'phase': plan['phase'], 'originals': sum(row['old'].startswith('photos/images/') for row in plan['files']),
                              'files': len(plan['files']), 'metadata': plan['metadata'], 'cloud_only_originals': plan['cloud_only_originals']}, ensure_ascii=False))
    finally:
        private_session.close({})


if __name__ == '__main__':
    main()
