# -*- coding: utf-8 -*-
"""套件 06：隔离沙盒下相册分类管理、多级图像流水线、MD5 查重、R2 直传与分类加解锁迁移"""

import os
import time
import io
from unittest import mock

from .helpers import make_test_png_bytes
from .sandbox import SandboxTestCase, photos

TIERS = ('images', 'thumbnails', 'previews')


class Test06_AlbumAndPhotosSandbox(SandboxTestCase):
    """在隔离沙盒中测试相册分类增删改查、多级图像生成 (Origin/AVIF/WebP)、去重与物理清理"""

    def test_15_cloud_mixed_formats_keep_independent_derivatives_and_retry_identity(self):
        """旧云端同编号的混合格式登记、重试及删除，不能覆盖另一张图片。"""
        from PIL import Image
        jpeg = io.BytesIO()
        Image.new('RGB', (40, 40), 'blue').save(jpeg, format='JPEG')
        names = ['20261028_120000_42.png', '20261028_120000_42.jpg']
        payloads = {f'photos/images/travel/{names[0]}': make_test_png_bytes('red'),
                    f'photos/images/travel/{names[1]}': jpeg.getvalue()}
        bodies = [{'category': 'travel', 'name': name, 'path': f'photos/images/travel/{name}'} for name in names]
        with mock.patch.object(photos, '_download_r2_image', side_effect=lambda key: payloads[key]) as download:
            code, first = self.call_post('/api/photos/register_r2', body=bodies[0])
            self.assertEqual(code, 200, first)
            before = {}
            for field in ('path', 'thumb', 'preview'):
                with open(self.root_path(first[field]), 'rb') as source:
                    before[field] = source.read()
            code, second = self.call_post('/api/photos/register_r2', body=bodies[1])
            self.assertEqual(code, 200, second)
            self.assertNotEqual(first['thumb'], second['thumb'])
            self.assertNotEqual(first['preview'], second['preview'])
            code, repeated = self.call_post('/api/photos/register_r2', body=bodies[0])
            self.assertEqual(code, 200, repeated)
            self.assertEqual(download.call_count, 2)
        for field in ('id', 'path', 'thumb', 'preview'):
            self.assertEqual(first[field], repeated[field], '重复登记不能生成新身份或衍生路径')
        self.assertEqual(len(self.gallery_json()['travel']), 2)
        self.assertEqual(first['path'], bodies[0]['path'], '登记不能改写已经上传的原图键')
        for field, expected in before.items():
            with open(self.root_path(first[field]), 'rb') as source:
                self.assertEqual(source.read(), expected)
        self.assertEqual(self.call_post('/delete', body={'path': second['path']})[0], 200)
        for field, expected in before.items():
            with open(self.root_path(first[field]), 'rb') as source:
                self.assertEqual(source.read(), expected)

    def test_14_media_regression_mixed_formats_have_independent_derivatives(self):
        """同一拍摄时间上传混合格式，不能覆盖或连带删除另一张图的衍生文件。"""
        from PIL import Image
        jpeg = io.BytesIO()
        Image.new('RGB', (40, 40), 'blue').save(jpeg, format='JPEG')
        with mock.patch.object(photos, 'get_exif_datetime', return_value=(time.localtime(1700000000), 1700000000)):
            first = self.upload_png('travel', 'first.png', 'red')
            before = {}
            for field in ('path', 'thumb', 'preview'):
                with open(self.root_path(first[field]), 'rb') as source:
                    before[field] = source.read()
            code, second = self.call_post('/upload', {'category': ['travel'], 'name': ['second.jpg']},
                                          file_data=jpeg.getvalue())
        self.assertEqual(code, 200, second)
        self.assertNotEqual(first['thumb'], second['thumb'])
        self.assertNotEqual(first['preview'], second['preview'])
        for image in (first, second):
            self.assertEqual(len({os.path.splitext(os.path.basename(image[field]))[0]
                                  for field in ('path', 'thumb', 'preview')}), 1)
        self.assertEqual(self.call_post('/delete', body={'path': second['path']})[0], 200)
        for field, expected in before.items():
            with open(self.root_path(first[field]), 'rb') as source:
                self.assertEqual(source.read(), expected)

    def add_category(self, cat_id, title, **extra):
        code, res = self.call_post('/api/add_category', body={'id': cat_id, 'title': title, **extra})
        self.assertEqual(code, 200, res)
        return res

    def tag_file(self, cat_id):
        return self.data_path('tags', f'photos-{cat_id}-tag-categories.json')

    def assert_tiers_exist(self, up, exist=True, keys=('path', 'thumb', 'preview')):
        for key in keys:
            path = self.root_path(up[key])
            with self.subTest(tier=key, path=up[key]):
                self.assertEqual(os.path.isfile(path), exist, f"{key} 物理文件存在性不符合预期: {up[key]}")

    def lock_category(self, cat_id, enc):
        code, start = self.call_post('/api/album/lock_category', body={'id': cat_id, 'enc': enc})
        self.assertEqual(code, 200, start)
        return self.wait_album_job(start['job'])

    # ---------- 分类管理 ----------

    def test_01_add_category(self):
        """创建相册分类并初始化三级物理目录与标签文件"""
        res = self.add_category('travel', '旅行摄影', subtitle='2026', cover='')
        self.assertEqual(res['status'], 'success')
        for sub in TIERS:
            self.assertTrue(os.path.isdir(os.path.join(self.temp_photos, sub, 'travel')))
        self.assertTrue(os.path.isfile(self.tag_file('travel')))

    def test_02_update_and_reorder_category(self):
        """更新分类信息与顺序"""
        self.add_category('cat1', '分类1')
        self.add_category('cat2', '分类2')
        self.assertEqual(self.call_post('/api/update_category', body={'id': 'cat1', 'title': '分类1-更新'})[0], 200)
        self.assertEqual(self.call_post('/api/reorder_category', body=['cat2', 'cat1'])[0], 200)

        conf = self.album_config()
        self.assertEqual([c['id'] for c in conf], ['cat2', 'cat1'])
        self.assertEqual(conf[1]['title'], '分类1-更新')

    def test_03_delete_category_purges_dirs(self):
        """delete_physical=True 彻底粉碎三级物理目录与标签文件"""
        self.add_category('temp_cat', '临时相册')
        code, res = self.call_post('/api/delete_category', body={'id': 'temp_cat', 'delete_physical': True})
        self.assertEqual(code, 200)
        self.assertTrue(res.get('tag_file_deleted'))
        for sub in TIERS:
            self.assertFalse(os.path.exists(os.path.join(self.temp_photos, sub, 'temp_cat')))

    # ---------- 图像流水线 ----------

    def test_04_upload_generates_three_tiers(self):
        """上传图片生成原图、WebP 缩略图、AVIF 预览图并同步 photos-data.json"""
        up = self.upload_png('travel', 'scenery.png', (20, 120, 220))
        self.assertEqual(up['status'], 'success')
        self.assertTrue(up['thumb'].endswith('.webp'))
        self.assertTrue(up['preview'].endswith('.avif'))
        self.assert_tiers_exist(up)
        self.assertEqual(len(self.gallery_json().get('travel', [])), 1)

    def test_05_upload_deduplication(self):
        """相同 MD5 的图片重复上传触发查重秒传，不重复入库"""
        png = (100, 200, 50)
        first = self.upload_png('travel', 'dup.png', png)
        second = self.upload_png('travel', 'dup_copy.png', png)
        self.assertEqual(second.get('msg'), 'duplicate_found')
        self.assertEqual(first['path'], second['path'])
        self.assertEqual(len(self.gallery_json()['travel']), 1)

    def test_06_update_tags_and_cleanup(self):
        """更新图片标签并支持相册标签清理"""
        up = self.upload_png('travel', 'tagged.png', (200, 50, 100))
        self.call_post('/api/cms/save_tag_categories', {'module': ['photos-travel']},
                       [{'name': '地点', 'tags': ['冰岛', '挪威']}])
        self.assertEqual(self.call_post('/api/photos/update_tags', body={'id': up['id'], 'tags': ['冰岛']})[0], 200)

        _, res = self.call_post('/api/cms/cleanup_tags', {'module': ['photos-travel']}, {})
        self.assertEqual(res['removed_tags'], ['挪威'])

    def test_07_reorder(self):
        """拖拽排序准确更新 gallery.db 与 photos-data.json"""
        up1 = self.upload_png('travel', 'p1.png', (10, 10, 10))
        time.sleep(0.01)
        up2 = self.upload_png('travel', 'p2.png', (20, 20, 20))
        # 反转顺序以确认排序真正生效（而非保持上传顺序）
        code, _ = self.call_post('/reorder', {'category': ['travel']}, body=[{'path': up2['path']}, {'path': up1['path']}])
        self.assertEqual(code, 200)
        self.assertEqual([p['id'] for p in self.gallery_json()['travel']], [up2['id'], up1['id']])

    def test_08_delete_removes_physical_files(self):
        """删除图片同步物理删除原图、缩略图与预览图"""
        up = self.upload_png('travel', 'del.png', (80, 80, 80))
        self.assertEqual(self.call_post('/delete', body={'path': up['path']})[0], 200)
        self.assert_tiers_exist(up, exist=False)
        self.assertEqual(self.gallery_json().get('travel', []), [])

    def test_09_cms_cover_upload_via_photos_pipeline(self):
        """CMS 模块封面 (literaturecovers) 复用图像流水线生成缩略图"""
        up = self.upload_png('literaturecovers', 'book.png', (150, 90, 40))
        self.assertTrue(up['thumb'].startswith('photos/thumbnails/literaturecovers/'))
        self.assert_tiers_exist(up, keys=('thumb',))

    def test_10_register_r2_cloud_upload(self):
        """register_r2 将移动端直传 R2 的原图登记入库并生成 WebP/AVIF 衍生图"""
        rel = 'photos/images/travel/mobile_r2_shot.png'
        os.makedirs(os.path.dirname(self.root_path(rel)), exist_ok=True)
        with open(self.root_path(rel), 'wb') as f:
            f.write(make_test_png_bytes((70, 130, 180)))

        code, res = self.call_post('/api/photos/register_r2', body={
            'category': 'travel', 'path': f"https://media.example.com/{rel}",
            'name': 'mobile_r2_shot.png', 'scope': 'public',
        })
        self.assertEqual((code, res['status']), (200, 'success'))
        self.assertTrue(res['thumb'].endswith('.webp'))
        self.assertTrue(res['preview'].endswith('.avif'))
        self.assert_tiers_exist(res, keys=('thumb', 'preview'))
        self.assertTrue(any(p['name'] == 'mobile_r2_shot.png' for p in self.gallery_json().get('travel', [])))

    # ---------- 分类加解锁 ----------

    def test_11_export_and_lock_category(self):
        """export_category 导出 -> lock_category 迁入私有桶并抹除公开图、标签文件与明文配置"""
        self.add_category('priv_cat', '私密相册', subtitle='2026')
        self.call_post('/api/cms/save_tag_categories', {'module': ['photos-priv_cat']}, [{'name': '人物', 'tags': ['家人']}])
        ups = [self.upload_png('priv_cat', 'a.png', (11, 22, 33)),
               self.upload_png('priv_cat', 'b.png', (44, 55, 66))]

        code, exp = self.call_post('/api/album/export_category', body={'id': 'priv_cat'})
        self.assertEqual(code, 200)
        self.assertEqual(exp['category']['id'], 'priv_cat')
        self.assertEqual((len(exp['photos']), exp['file_count']), (2, 6))
        self.assertIn('家人', exp['tags_file'])

        cipher = 'enc:iv_album.cipher_album_payload'
        job = self.lock_category('priv_cat', cipher)
        self.assertEqual(job['state'], 'success', f"相册加锁任务失败: {job}")
        self.assertEqual(job['result']['moved'], 6)

        for up in ups:
            for k in (up['path'], up['thumb'], up['preview']):
                self.assertIn(k, self.mock_s3.buckets['priv-bucket'])
            self.assert_tiers_exist(up, exist=False, keys=('thumb', 'preview'))
        self.assertFalse(os.path.exists(self.tag_file('priv_cat')), "加锁后分类标签配置文件必须被删除")
        self.assertNotIn('priv_cat', self.gallery_json())
        self.assertEqual(self.album_config(), [{'_enc': cipher}])

    def test_12_unlock_category_restores_everything(self):
        """unlock_category 从私有桶迁回三尺寸图像、重建 SQLite 行与标签文件并清空私有桶"""
        self.add_category('restore_cat', '待恢复相册')
        self.call_post('/api/cms/save_tag_categories', {'module': ['photos-restore_cat']}, [{'name': '胶片', 'tags': ['Portra400']}])
        up = self.upload_png('restore_cat', 'film.png', (99, 88, 77))
        _, exp = self.call_post('/api/album/export_category', body={'id': 'restore_cat'})

        cipher = 'enc:iv_restore.cipher_restore'
        self.assertEqual(self.lock_category('restore_cat', cipher)['state'], 'success')
        self.assertFalse(os.path.exists(self.root_path(up['path'])), '加锁后本地原图也应移除')

        payload = {'category': exp['category'], 'photos': exp['photos'], 'tags_file': exp['tags_file']}
        code, start = self.call_post('/api/album/unlock_category', body={'enc': cipher, 'payload': payload})
        self.assertEqual(code, 200)
        job = self.wait_album_job(start['job'])
        self.assertEqual(job['state'], 'success', f"相册解锁任务失败: {job}")
        self.assertEqual(job['result']['restored'], 3)

        self.assertIn(up['path'], self.mock_s3.buckets['pub-bucket'])
        self.assert_tiers_exist(up)
        for k in (up['path'], up['thumb'], up['preview']):
            self.assertNotIn(k, self.mock_s3.buckets['priv-bucket'], f"解锁后私有桶副本未清除: {k}")
        self.assertTrue(os.path.isfile(self.tag_file('restore_cat')))
        self.assertEqual(len(self.gallery_json().get('restore_cat', [])), 1)
        self.assertEqual(self.album_config()[0]['id'], 'restore_cat')

    def test_13_lock_abort_preserves_data_on_r2_failure(self):
        """R2 私有桶上传失败时立即中止，绝不删除本地图片、数据库行或明文配置"""
        self.add_category('safe_cat', '故障保护测试')
        up = self.upload_png('safe_cat', 'keep.png', (12, 34, 56))

        self.mock_s3.fail_on_upload = True
        self.assertEqual(self.lock_category('safe_cat', 'enc:iv.fail')['state'], 'error')

        self.assert_tiers_exist(up)
        self.assertEqual(len(self.gallery_json().get('safe_cat', [])), 1, "R2 故障中止时不应删除 gallery 记录")
        self.assertEqual(self.album_config()[0].get('id'), 'safe_cat')
        self.assertTrue(os.path.isfile(self.tag_file('safe_cat')), "R2 故障中止时不应删除标签文件")
