# MAERS Public Web

开源空白模板，采用 **GPL-3.0-only**。不含原作者的文章、照片、收藏、加密内容、密码、账号配置或 Git 历史。第三方组件保留各自许可证。

本仓库是开源发布版本。每次更新均保持现有版本号不变，不递增全局版本、模块版本或单文件版本；具体约定见[开发规范](_说明/开发规范.md#8-版本与离线缓存-ver)。

首次运行请安装 Python 依赖：`python -m pip install -r _studio/requirements.txt`，然后执行 `python -B _studio/server.py`，在浏览器打开 `http://127.0.0.1:8001/admin`。Windows 可使用随附的可移植 `Maersy.exe`，启动器需留在项目目录。

配置自己的云服务与发布前检查见[开源版本说明](_说明/开源版本说明.md)。


Maersy 是一个追求极致轻量、零框架依赖、原生体验的个人数字花园与内容管理生态系统。

项目采用**“纯静态访客端 (Viewer) + 本地原生桌面管理端 (Admin)”**混合架构：线上可零成本部署于 GitHub Pages / Vercel / Cloudflare，本地通过单文件桌面启动器 `Maersy.exe` 提供完整的 Markdown 创作、多级图像压缩、端到端加密、垃圾数据清理及 Git / R2 云同步能力。

---

## ✨ 核心特性

| 模块 | 核心能力 |
| :--- | :--- |
| **📝 CMS 内容系统** | **文件驱动存储**（JSON 与 Markdown 为真源，SQLite 仅为可重建缓存）；内置全本地化 **Vditor** 引擎（支持思维导图、数学公式、流程图与 `H1-H6` 动态目录大纲）；支持页内 `.md` 内链拦截与跨模块 `?openNote=` 直达；支持 `AND` / `OR` / `DEL` 三模标签筛选。 |
| **📚 Literature 文学** | **Flow Engine 2.0** 参数化自适应 3D 流动书架，根据视口、间距与数据量自动计算回路与离屏跑道，实现零闪烁循环漫游。 |
| **🖼️ Album & Photos** | 自适应瀑布流与高清缩放灯箱；上传自动生成 **原图 + 1600px AVIF 预览图 + 400px WebP 缩略图**；支持 Cloudflare R2 同步与相册分类级私密加锁。 |
| **🎵 Music 音乐** | 支持悬浮窗画中画 (PiP) 歌词显示、跨页面无缝续播，支持输入 Bilibili `BV` 号自动抓取封面与分 P 曲目列表。 |
| **🎮 Games & 🎬 Videos** | 标准 2:3 竖版海报网格；Games 内置 `Playing` 随机抽取沙盒与 `Played` 归档双视图；Videos 支持与 Music 标题联动切换。 |
| **🌌 Space 空间** | 结合树状导航 (`space-tree.json`) 与多维收藏集 (`space-collections.json`)，输入 URL 自动抓取网页标题与 Favicon。 |
| **🔐 正文与记录加密** | 基于浏览器原生 Web Crypto API (`PBKDF2` + `AES-GCM`) 与密钥环 (`crypto-keyring.json`) 加密私密正文、文章及相册记录；图片文件使用私有存储与令牌鉴权，尚未端到端加密。 |
| **📲 PWA 与全站离线** | 支持安装为桌面/手机端 PWA 应用；右下角内置离线下载面板 (`offline-download.js`)，支持一键缓存全站框架、JSON 索引、Markdown 文档与缩略图/高清预览图。 |
| **🖥️ 原生桌面工作台** | 根目录内置 `Maersy.exe` 原生启动器，无黑框静默启动 Python 后端、自动检测补齐依赖、以独立 `--app` 窗口打开后台门户，关闭窗口自动停服。 |

---

## 📂 目录结构

```text
MAERS-Public-Web/
├── Maersy.exe                  # 原生桌面端启动器 (无黑框静默拉起后台 + 独立窗口)
├── index.html / *.html         # 访客端与管理端 (admin-*.html) 页面入口
├── maers-version-controller.js # Service Worker 三级版本缓存控制与离线回退引擎
├── manifest.json               # PWA 应用清单配置
├── _studio/                    # [Backend] Python 后端核心引擎 (仅 Admin 模式运行)
│   ├── server.py               # 依赖自动检测安装 + ThreadingTCPServer 启动入口
│   ├── routes.py               # API 路由分发控制器
│   ├── config.py               # 全局路径与端口配置
│   ├── services/               # CMS、相册、音乐、空间、加解密、Git、垃圾清理服务
│   ├── tests/                  # 自动化测试包与入口 run_tests.py（只读契约 / 规范守卫 / 沙盒回归 / Node 运行时）
│   └── tools/                  # Maersy.exe 编译脚本与 R2 同步工具
├── custom/                     # [Frontend] 按业务模块隔离的视图 (viewer) 与管理 (admin) 代码
├── shared/                     # [Infra] 跨模块基础设施 (Flash Guard、主题、空间导航、Toast)
├── data-manage/                # [Middle-end] 管理端基建 (admin/)、端到端加密 (encrypt/) 与跨端云同步 (sync/)
├── static-style/               # [Style] 全局 CSS 变量、基础组件与响应式样式表
├── data/                       # [Data] JSON 真源、Markdown 正文 (.md) 与本机 SQLite 缓存
├── photos/                     # [Media] 原图 (images)、高清预览 (previews) 与缩略图 (thumbnails)
└── _说明/                      # [Docs] 开发规范、架构决策记录、前后端开发指南与文件字典
```

---

## 🚀 快速开始

### 1. 管理模式 (Admin Mode — 本地创作与运维)

无需手动打开终端或运行批处理脚本，直接双击项目根目录下的 **`Maersy.exe`**：

1. **自动环境自检**: 启动器在后台静默拉起 `_studio/server.py`，自动检测 `Pillow`、`pillow-avif-plugin`、`boto3` 等依赖，若缺失则自动调用 `pip` 静默安装。
2. **独立桌面窗口**: 自动以无地址栏独立应用窗口打开后台管理门户 `http://localhost:8001/admin-portal.html`（启动器留在项目目录，重复双击会自动唤醒已有窗口）。
3. **一站式运维**: 在后台门户顶部工具栏即可一键执行 **🧹 清理垃圾**（清理未引用孤儿图片/附件与孤儿 `.md` 文档）、**📦 Git 提交推送**（内置推送前静态契约与规范守卫门禁自检）、**☁️ 多端云同步** 与 **🔐 加密密钥设置**。
4. **即关即停**: 关闭后台管理窗口后，后台 Python 服务进程自动终止并释放服务端口。端口只在 `_studio/config.py` 定义，启动器与前端自动读取当前配置。

> **命令行调试与自动化测试（可选）**:
> - 启动本地服务并查看实时终端日志：`python _studio/server.py`
> - 运行全量自动化契约与沙盒回归测试：`python -B _studio/tests/run_tests.py`
> - 仅运行只读契约与规范守卫（与推送前门禁一致）：`--fast`；按名称过滤：`-k janitor`；首错即停：`-x`
> - 查看代码规范技术债台账：`--debt`；修复欠账后收缩基线：`--shrink-baseline`

### 2. 访客模式 (Viewer Mode — 纯静态部署)

项目前端基于静态 JSON 快照与按需 Fetch `.md` 构建。Vercel 根据 `vercel.json` 执行 `node _studio/tooling/build-site.mjs`，只发布生成的 `dist/`，无需线上 Python 服务。其他静态托管同样以 `dist/` 为发布目录，不要部署整个仓库。`dist/` 可随时重建，不纳入 Git。

发布目录保留 `admin-*.html` 及其依赖，支持线上云端模式；本机加密设置模块、完整密钥环及恢复材料不发布。云端写入仍需配置中继并通过鉴权，本机 API 功能仍需使用本地后台。

完整密钥环和恢复材料保存在 `_studio/.local/crypto-keyring.json`，纳入后台“完整备份”，不进入 Git 或站点产物。换电脑时请恢复完整备份，单独克隆仓库不足以恢复后台管理及恢复码功能。公开密钥环仅含密码包裹槽、密钥 ID、版本和取图地址；旧版完整密钥环在后台启动时自动迁移。

---

## 📖 技术文档索引 (`_说明/`)

深入了解系统架构与开发规范，请查阅 [`_说明/`](_说明/) 目录下的专项文档：

- 📕 **[开发规范 (强制)](_说明/开发规范.md)** — 项目开发必须遵守的唯一规则源，涵盖文件创建、代码规范与自动化守卫
- 📘 **[项目说明书 (必读)](_说明/项目说明书(必读).md)** — 系统全景概览与管理员操作指南
- 🗺️ **[文件功能说明](_说明/文件功能说明.md)** — 全站文件级功能字典与数据规模建议
- 🎨 **[前端开发指南](_说明/前端开发指南.md)** — ES6 模块规范、关键渲染路径、CSS 分层与移动端适配
- ⚙️ **[后端开发指南](_说明/后端开发指南.md)** — `_studio/` 引擎架构、完整 API 路由规范与内容管理手册
- 🤖 **[AI 开发指南](_说明/AI开发指南.md)** — AI 辅助开发上下文约束、工作流与自检清单
- 🏛️ **[架构决策记录 (ADR)](_说明/架构决策记录.md)** — `ADR-001` 至 `ADR-040` 关键架构演进记录
- 🔍 **[细节设计说明](_说明/细节设计说明.md)** — Flash Guard、Flow 2.0、E2EE 密钥环、离线缓存、自动化测试与规范守卫解析
- 📅 **[项目更新日志](_说明/项目更新日志.md)** — 版本功能迭代与底层重构历史


开发测试还需 Node.js 与固定 npm 开发依赖；安装 Git hooks、浏览器测试、自动版本号和 Vditor 补丁构建见[开发工具说明](_studio/tooling/README.md)。


数据备份、回收恢复、媒体存储替换及旧凭据撤销，请参阅[数据保障与存储迁移](_说明/数据保障与存储迁移.md)。图片文件当前采用私有存储与令牌鉴权；文章和相册记录使用 AES-GCM 加密。后台启动验证一次主密码后即可正常编辑加密内容，保存时自动重新加密，不额外保存明文工作副本；线上访客仍在浏览器解密阅读。
