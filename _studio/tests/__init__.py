# -*- coding: utf-8 -*-
"""
MAERS 自动化测试包。

套件注册表（按需懒加载，推送前门禁只导入只读套件，不加载后端 routes/services 与 Pillow）：
  只读契约：
    01 静态资源 / 关键渲染路径 / ES6 import 与导出符号 / CSS / Python 语法 / 桌面启动器
    02 PWA 清单 / Service Worker 版本控制 / 离线下载清单
    03 data/ JSON 快照 / SQLite Schema / .md 一致性 / 卡片引用
    04 前端零全局污染 / 加密与同步架构边界 / E2EE 门面导出
  沙盒回归（临时目录，绝不触碰真实数据）：
    05 CMS 节点 CRUD / .md 联动 / 加解锁 / 私密封面 R2 迁移 / 标签
    06 相册分类 / 三级图像流水线 / 查重 / R2 直传 / 分类加解锁与故障回滚
    07 Space / Music / 建页安全 / 密钥环防覆盖 / Janitor
  运行时（需 Node.js，缺失时自动 skip）：
    08 全站 JS 语法 / WebCrypto 密钥环 / CMS 脱敏 / 中继同步 / Markdown 管线
  规范守卫（只读，纳入门禁）：
    09 文件命名 / 目录结构 / JS·CSS·Python 编码规范（棘轮基线） / 版本号同步

  HTTP 安全（临时回环服务与沙盒）：
    10 来源 / Host / 会话令牌 / 预检 / 请求体边界 / 鉴权后的真实路由写入

用例数量由运行器动态统计，文档中不再硬编码。
"""

import importlib
from collections import namedtuple

Suite = namedtuple('Suite', 'module cls readonly')

SUITES = (
    Suite('test_01_static_contracts', 'Test01_StaticContracts', True),
    Suite('test_02_pwa_cache', 'Test02_PwaAndCacheContracts', True),
    Suite('test_03_data_integrity', 'Test03_DataAndStorageIntegrity', True),
    Suite('test_04_frontend_architecture', 'Test04_FrontendArchitectureContracts', True),
    Suite('test_05_cms_sandbox', 'Test05_CmsBackendSandbox', False),
    Suite('test_06_album_photos_sandbox', 'Test06_AlbumAndPhotosSandbox', False),
    Suite('test_07_space_music_janitor_sandbox', 'Test07_SpaceMusicPortalAndJanitorSandbox', False),
    Suite('test_08_js_runtime', 'Test08_FrontendJsRuntimeAndE2EECrypto', False),
    Suite('test_09_code_standards', 'Test09_CodeStandards', True),
    Suite('test_10_http_security', 'Test10_HttpSecurity', False),
    Suite('test_11_storage_architecture', 'Test11_StorageArchitecture', False),
    Suite('test_12_engineering', 'Test12_Engineering', False),
    Suite('test_13_data_safety', 'Test13_DataSafety', False),
    Suite('test_13_data_safety', 'Test13_PrivateAdmin', False),
)


def load_suite_classes(readonly_only=False):
    """按注册顺序导入并返回测试类列表"""
    classes = []
    for suite in SUITES:
        if readonly_only and not suite.readonly:
            continue
        module = importlib.import_module(f'{__name__}.{suite.module}')
        classes.append(getattr(module, suite.cls))
    return classes
