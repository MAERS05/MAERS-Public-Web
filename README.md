# MAERS Public Web

基于原生 HTML、CSS、JavaScript 和 Python 的空白个人网站与本机内容工作台。保留首页、笔记、文学、记录、游戏、影视、音乐、相册、空间导航及管理界面。项目自有代码沿用 GPL-3.0-only，第三方组件保留各自许可证。

初始文章、照片、相册分类、音乐、收藏、标签和更新动态均为空。首页与管理门户保留通用导航卡片。

桌面界面采用中文侧栏导航与浅灰绿色主题，统一 SVG 图标、确认弹窗和更新动态；封面使用紧凑的 2:3 网格，照片按原比例排列。界面约定见[前端设计说明](_说明/前端设计说明.md)。

## 本机运行

需要 Python 3.10+ 和 Node.js 22.12+。在项目根目录运行下面的命令。

    python -m pip install -r _studio/requirements.txt
    npm ci --prefix _studio/tooling
    python -B _studio/server.py

管理入口为 <http://127.0.0.1:8001/admin>，访客首页为 <http://127.0.0.1:8001/index.html>。Windows 也可双击项目中的 Maersy.exe，它会在首次运行时检查运行环境。启动器从所在目录定位项目，使用时请留在项目文件夹内。

## 静态发布

    node _studio/tooling/build-site.mjs

将生成的 dist/ 作为静态托管根目录。管理页面保留，但本机功能需要 Python 工作台，线上编辑与云端正文、图片访问需要配置自己的同步和存储服务。配置入口及首次运行说明见[开源版本说明](_说明/开源版本说明.md)。

## 内容与配置

- Markdown 正文位于 markdown/，JSON 索引和标签配置位于 data/。
- 图片及其预览、缩略图位于 photos/，首次上传时创建目录。
- 默认采用本机媒体存储。公开图片、正文基址和同步 Worker 地址均为空。
- 联系表单初始禁用。使用前配置自己的接收地址。
- 首次启用加密时设置自己的主密码和恢复材料。
- 本机密钥、会话与备份写入 _studio/.local/，媒体凭据写入被 Git 忽略的配置文件。

公开分发前检查自己新增的内容、配置与构建产物。分发时排除本机状态、媒体凭据、数据库、缓存、备份和环境文件。

## 验证与维护

    python -B _studio/tests/run_tests.py
    npm run test:e2e --prefix _studio/tooling

公开版本保留既有版本号，遵循[开发规范](_说明/开发规范.md)的固定版本约定。已有 Git hooks 含版本准备逻辑，采用本仓库约定时请按[开发工具说明](_studio/tooling/README.md)运行检查，勿启用自动版本递增。

[文件功能说明](_说明/文件功能说明.md)和[开源版本说明](_说明/开源版本说明.md)提供模块、配置和分发说明。完整许可证位于 [LICENSE](LICENSE)。
