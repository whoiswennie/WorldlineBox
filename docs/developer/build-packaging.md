# 构建与打包

## 基础命令

```bash
npm run package          # 打包应用（含构建）→ out/WorldlineBox-<platform>-<arch>/
npm run make             # 生成安装包 → out/make/（macOS dmg / Windows zip；Windows 安装器 WorldlineBoxSetup.exe 由 Inno Setup 构建）
npm run verify:package   # 校验打包产物（ASAR、native 模块、媒体组件）
```

`package`/`make` 的 prepackage/premake 钩子会先确保媒体依赖可用：

- 媒体二进制（`media-binaries ensure`，必要时从锁定 release 恢复后校验来源与哈希）
- ufbx WASM 产物（`verify-ufbx-wasm`，哈希锁 `scripts/ufbx-wasm-lock.json`）
- 打包产物完整性（`verify:package`：ASAR、better_sqlite3.node、Host utilities）

`package`/`make` 会更新 dev 的 Electron binary，跑完执行 `npm run rebuild:native` 恢复。

如果媒体可执行文件缺失，或本地文件与已晋升的 manifest 不一致，钩子会自动从
锁定的 `WorldlineBox-Build` release 下载并重新校验。也可以手动执行同一流程：

```bash
npm run media:ensure
```

离线环境可设置 `WORLDLINEBOX_MEDIA_AUTO_ACQUIRE=0`，此时校验失败会直接报错，不会联网下载。

## Forge / Vite 配置验证

```bash
node scripts/verify-vite-forge-builds.mjs
```

这个检查通过 Forge 实际配置合并路径，分别构建开发模式与生产模式的所有入口。
产物和 `report.json` 放在新建的 `.tools/vite-forge-smoke-*` 目录；不会重写开发 `.vite`
或启动服务。检查还确认 preload、QuickJS 和插件 UtilityProcess 仍是单个 CJS 入口。

Forge 7 的 preload 模板自动加入旧 `inlineDynamicImports`。项目在配置 hook 中将最终
合并选项迁移为 `codeSplitting: false`，保持单文件语义，避免 Vite 8 / Rolldown 的弃用警告。
说明见 [Rolldown 输出选项](https://rolldown.rs/reference/OutputOptions.codeSplitting)。
不要修改依赖目录、屏蔽日志或让 Main 全部内联；Main 的 DSH 懒加载继续保留。

## 发布流水线（release:local）

一键全流程：

```bash
npm run release:local
```

阶段：`verify` → `media` → `package` → `e2e` → `make` → `checksums`

| 阶段 | 内容 |
| --- | --- |
| verify | `rebuild:native` + `verify:mainline`（与 CI 相同门禁） |
| media | 从受控 URL 下载媒体包（`media:acquire`）+ 校验；Linux x64/arm64 使用相同门禁，arm64 尚未晋升时拒绝正式发布 |
| package | `electron-forge package` + `verify:package` |
| e2e | 对打包产物跑启动测试（`test:e2e:packaged`） |
| make | 生成安装包；Linux 优先使用同架构 Docker，并生成对应架构 AppImage |
| checksums | 产物 SHA-256 manifest（带版本头） |

跳过慢阶段的选项：`--skip-verify` / `--skip-media` / `--skip-e2e`。单独跑某阶段：`npm run release:<phase>`（e2e 阶段为 `npm run release:e2e:packaged`）。

```mermaid
flowchart LR
    C[代码变更] --> L[Lint + typecheck]
    L --> U[Unit tests]
    U --> W[Worker integration]
    W --> E[Electron E2E]
    E --> P[Package + verify]
    P --> PE[Packaged E2E]
    PE --> R[Make release artifacts]
```

### 本地试跑（无媒体晋升时）

媒体包需先"晋升"（构建产物登记进 `bundle-lock.json` 的不可变 URL + 哈希）才能走正式流水线。本地已有匹配 `source-lock.json` 的产物时，跳过 provenance 校验：

```bash
WORLDLINEBOX_MEDIA_SKIP_PROVENANCE=1 npm run release:local -- --skip-verify --skip-media
```

> `SKIP_PROVENANCE` 只用于本地试跑，正式发布必须走晋升流程。

另一条本地路径是 `--build-media-locally`：在本机用 vcpkg 完整构建媒体组件（`scripts/media-build/*`，耗时 1-3 小时）后自动以本地产物放行门禁：

```bash
npm run release:local -- --skip-verify --build-media-locally
```

### 版本

- 版本号在 `package.json`，semver 格式
- 提升：`npm version patch|minor|major`（自动打 tag）
- 每次流水线运行输出 `WorldlineBox v<版本>`；checksum manifest 带版本头

### 平台

`forge.config.ts` 强制**原生平台构建**，媒体白名单为 `darwin-arm64` / `win32-x64` / `linux-x64` / `linux-arm64`。媒体二进制、ufbx、native 模块均为平台相关，不支持交叉打包。各平台须在匹配操作系统和架构的宿主机或同架构 Linux 容器中运行发布流水线。源码中的平台支持不代表对应制品已经构建或通过实机验收。

### Linux AppImage

```bash
npm run make:appimage           # out/make/appimage/WorldlineBox-<版本>-x86_64.AppImage 或 -aarch64.AppImage
npm run make:appimage:docker    # 同架构 Ubuntu 22.04 / glibc 2.35 构建环境
npm run release:make            # 规范命名 WorldlineBox-linux-x86-64-<版本>.AppImage 或 -arm64-<版本>.AppImage
```

- Linux x64 与 arm64 都必须获取、验证并打包 `ffmpeg` / `ffprobe` / `oiiotool`，不再按架构跳过媒体或打包完整性门禁。x64 的 `bundle-lock.json` 已锁定上游 `media-v0.1.3`，该包使用 Ubuntu 22.04 重建以降低 glibc 基线，源版本与配置不变。
- Linux arm64 当前仍是 `build-required`。必须在原生 Linux aarch64 上运行 `scripts/media-build/linux-arm64.sh`，将受信 ZIP、归档 SHA-256、manifest SHA-256 登记为 `ready` 后才能正式发布。上游也尚未晋升这一架构的媒体包，不能把已有脚本描述成现成可用安装包。本地 `--build-media-locally` / `WORLDLINEBOX_MEDIA_SKIP_PROVENANCE=1` 试跑不等于正式晋升，也不会凭空补齐缺失的二进制。
- Linux 媒体包应在 Ubuntu 22.04 容器内使用系统 GCC 构建；发布前检查每个二进制最高 GLIBC 要求不高于 2.35：`objdump -T <二进制> | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1`。在较新宿主机直接构建可能提高运行要求，不能只凭 AppImage 外壳宣称兼容旧发行版。
- AppImage 运行需要 FUSE（通常为 `libfuse2`）；也可加 `--appimage-extract-and-run`。两种架构采用相同的窗口系统与权限限制；X11、原生 Wayland、GPU、截图/录屏等需各自在 Linux 实机验收。
- 发布名与更新器一致：`WorldlineBox-linux-x86-64-<版本>.AppImage` / `WorldlineBox-linux-arm64-<版本>.AppImage`，附同名 `.sha256`；总清单为 `SHA256SUMS-linux-x64.txt` / `SHA256SUMS-linux-arm64.txt`。

本轮 Windows 开发机没有可用 Docker、bash 或 WSL Linux 环境，未进行 Linux 构建或实机验收。已完成范围及环境证据见 [平台同步审计](serpent-031-upgrade/platforms-audit.md)。

### Windows 安装器（Inno Setup）

Windows 安装器 `WorldlineBoxSetup.exe` 用 **Inno Setup 6** 构建（脚本 `assets/inno/worldlineboxsetup.iss`，输出至 `out/make/inno/WorldlineBoxSetup.exe`）。Windows 用户可双击根目录的 `01-Setup-Environment.bat` 准备环境、`02-Start-Development.bat` 启动开发模式、`03-Build-Installer.bat` 生成安装包。仅 `01` 安装 Node.js（版本来自 `.nvmrc`）、npm 依赖、Electron 原生模块、校验过的媒体组件及 Inno Setup 6.7.3，工具保存在 `.tools/` 中。`02` 不安装依赖、不重编译原生模块，缺环境或依赖锁变化时提示先运行 `01`；正常启动仍会编译当前源码。`03` 检查已有环境并构建 EXE 安装包。原生修复用 `--only better-sqlite3`，保留 `node-pty` 自带的 NAPI 预编译模块。正常开发启动和安装版共享当前用户 `%APPDATA%\WorldlineBox`，DSH 下载缓存、运行版本与实例放在其 `dsh-launcher` 下，不放项目 `.tools`。

统一自定义目录使用绝对路径 `WORLDLINEBOX_USER_DATA_PATH`，开发版与安装版均生效。
E2E 优先使用独立 `WORLDLINEBOX_E2E_USER_DATA_PATH` 或临时目录；显式
`WORLDLINEBOX_ALLOW_MULTI_INSTANCE=1` 才使用共享目录下 `dev-instances/pid-*`。
旧 `WORLDLINEBOX_DEV_USER_DATA_PATH` 不再决定正常启动目录，只能作为旧 DSH 存储迁移来源。

旧项目 `.tools/dev-user-data/dsh-launcher` 在无实例与已安装环境、无运行操作且目标
`dsh-launcher` 不存在时，以物理文件复制和前后 SHA-256 校验迁入共享目录。旧目录保留，
已有用户资产、世界和 Chromium 首选项不复制或覆盖。有实例的旧存储需通过完整备份或整合包导入，
不会直接合并绝对路径。已有目标目录时跳过自动迁移。

媒体组件由 `bundle-lock.json` 中的不可变上游发布 ID 定位，下载后仍校验原有 ZIP 和清单的 SHA-256。如果 GitHub API 暂时限流，可使用 `node scripts/media-binaries.mjs acquire --archive <可信ZIP路径>` 离线导入；校验不通过时停止，不会忽略发布检查。

手动构建：

打包前会从公开的命令 Registry 自动生成 `docs/manual/scripts/automation-api.d.ts`；发布校验检查其 API 版本和命令列表。此流程不依赖未随源码交付的内部 skill 目录。Windows 安装器的中文语言文件及许可证随仓库提供，Inno Setup 不需要额外手动安装中文翻译。

#### 1. 安装 Inno Setup 编译器依赖（ISCC.exe）

运行构建脚本 `npm run make:inno` 时需要 `ISCC.exe`，可通过以下两种方式之一准备：

- **免管理员方式（推荐）**：
  从 NuGet 下载 `Tools.InnoSetup`，将其解压后将包含 `ISCC.exe` 的目录放置在 `%LOCALAPPDATA%\WorldlineBoxTools\inno\tools`（脚本会默认查找此路径）。
- **官方安装方式**：
  安装官方 Inno Setup 6，并将环境变量 `WORLDLINEBOX_INNO_TOOLS` 设置为 `ISCC.exe` 所在的绝对目录（例如 `C:\Program Files (x86)\Inno Setup 6`），或直接将该目录加入系统 `PATH`。

#### 2. 构建命令

```bash
# 1. 先打包应用（生成 out/WorldlineBox-win32-x64）
npm run package

# 2. 执行 Inno 安装器构建脚本
npm run make:inno
```

- 多语言：安装启动时显示语言选择（默认跟随系统语言），中英双语
- 安装向导：安装路径选择（默认 `C:\Program Files\WorldlineBox`）、开始菜单/桌面快捷方式
- per-machine 安装（UAC 提权）、自动生成卸载器 `unins000.exe` 与应用和功能条目

> 历史：早期尝试过 Squirrel（无向导/无路径选择/卸载残留）与 WiX MSI（MSI 语言切换需自定义 bootstrapper，社区确认不可内置）均已回退，见 [Windows 打包开发日志](https://github.com/whoiswennie/WorldlineBox/blob/dev/docs/internal/development/2026-08-08-windows-packaging-and-squirrel-installer-development-log.md)。

## 媒体二进制晋升（WorldlineBox-Build）

媒体 bundle（FFmpeg/OpenImageIO）经 [WorldlineBox-Build](https://github.com/dolag233/WorldlineBox-Build)
仓库的 GitHub Release（不可变 URL + SHA-256）分发，主仓 `media:ensure`
会自动下载并强制校验：

1. **构建一次**（非 CI）：
   - `ffmpeg/ffprobe`：BtbN LGPL builds（`registry.npmmirror.com/-/binary/ffmpeg-builds/`
     `ffmpeg-<ver>-win32-x64-lgpl.tar.xz`，或 mac 版），LGPL-only 合规（无 GPL 标记）
   - `oiiotool`：`scripts/media-build/build-oiiotool-win32.ps1`（Windows）/
     `darwin-arm64.sh`（macOS）/ `linux-x64.sh`（Linux x86_64）/ `linux-arm64.sh`（Linux aarch64，连同 FFmpeg）——vcpkg 构建（锁定版本工具链 + registry commit）
2. **打包上传**：
   ```bash
   # 组装 zip（平台层级结构 ffmpeg/<platform>/…）+ sha256
   # 上传（创建/复用 Release media-v<ver> + assets + 发布）：
   node scripts/release/publish-media-bundle.mjs --platform win32-x64 \
     --version v0.1.1 --zip artifacts/media-binaries/worldlinebox-media-win32-x64.zip
   ```
3. **主仓晋升**：`resources/media-binaries/bundle-lock.json` 对应平台条目
   填 `{status: ready, url, sha256, size, manifestSha256}`（脚本输出贴入）。

> 版本策略：bundle 版本独立于应用版本（`media-vX.Y.Z`）；Release 启用
> Immutable Releases（资产不可改删、tag 不可复用）。

## 浏览器扩展

扩展不通过商店上架，构建后内嵌进应用包（`Resources/extension`）：

```bash
npm run extension:build   # 构建 dist/extension
```

`prePackage` 自动重建扩展。用户手动加载方式见[使用手册](../user-guide/installation.md)。

## 签名

- **macOS**：打包时做临时签名（`identity: '-'`，并关闭钥匙串身份校验，否则查找失败会被静默跳过，产物仍会被系统说成「已损坏」）。临时签名没有共同的团队标识，授权文件里要允许加载同包框架，否则应用一启动就被系统关掉。这不消除「无法验证开发者」；第一次打开需右键「打开」。拿到 Developer ID 证书后替换 identity 并补 `osxNotarize`
- **Windows**：当前未签名（SmartScreen 警告）。正式发布建议 SignPath 免费签名（VSCodium 同款）或商业证书

## 发布前置（进行中）

1. **媒体晋升**：工具链仓库（Release 附件 + `versions.json`），解除 `SKIP_PROVENANCE`
2. **Windows 原生验证**：同一流水线在 Windows 环境跑通 + 安装/卸载旅程
3. **签名升级**：SignPath 申请 / Apple Developer 账号
4. **CI/CD**：本地 CICD（2026-08-09 决策：主仓库放弃 GitHub Actions，
   双平台各自跑 `npm run release:local`；浏览器扩展仓库保留 Actions 发布）。
   详见 [本地 CICD](https://github.com/whoiswennie/WorldlineBox/blob/dev/docs/internal/development/local-cicd.md)。

详见研究文档。


### 启动阶段与首帧诊断

启动只显示一个 440×300 的本地小窗口，依次报告读取启动设置、注册服务入口、准备数据入口、打开首页的真实完成步骤与用时。进度条按已完成阶段单向前进。主窗口的 HTML 与 React 在后台装载，须同时收到原生 `ready-to-show` 及主文档 React 提交后的绘制确认，才显示完整首页并销毁小窗口。通知仅接受对应窗口的主框架，完成/关闭后移除监听与计时器；关闭不记为启动成功。模块失败、进程退出或超过 60 秒未完成时，在同一小窗口显示原因，最多手动重试两次，不改动存档。单独重载时的 HTML 后备显示采用侧栏骨架与简短状态，功能首次加载仅在对应区域显示状态，不再展示全窗口大 Logo 或循环进度条。

首页只挂载启动器。伙伴、素材管理、终端和音乐界面首次使用才加载；未访问的 React Activity 内容不预渲染。素材库 Worker、最近库恢复及同步调度在首次素材请求时启动，伙伴存储、记忆与生活调度在首次伙伴请求时启动。3D 世界渲染仅在打开世界观测窗口时加载。已启用的伙伴后台任务继续遵守其生命周期，切换页签不会丢弃工作。DSH 启动器初始化只读取本地清单，不自动检测所有运行版本或预热 CLI；使用/安装版本仍执行各自检查。便携工具保持首次实际使用时的完整 SHA256 校验，启动首页无需遍历工具载荷。

开发模式必须排除大型生成目录的监视：`.tools`、`.vite`、`out`、`artifacts`、测试报告和已展开的工具/媒体载荷。统一规则在 `scripts/dev-watch-paths.mjs`，由 Vite renderer 配置使用。否则 Chokidar 扫描测试存档、工具运行库及打包副本会造成 GB 级开发进程内存占用和模块请求停顿，表面表现为界面加载超时。开发导航不再每 20 秒强制重载或等待素材库专属 DOM；最终就绪统一由 React 绘制确认。

`node scripts/test-dev-bat.mjs` 实际调用 `02-Start-Development.bat`，使用独立临时用户数据、专属进程 Job 和端口，检查首页不加载重模块/数据 Worker、设置和主题可用，并保存资源请求、进程内存及阶段日志；结束后仅关闭自身进程并清除自身临时数据。`--hardware-gpu` 可覆盖软件渲染验收之外的真实 GPU 路径。开发编译时间与应用内部启动阶段分别记录，不能用打包版本的测试替代 BAT 验收。

2026-10-17 本机验证：实际开发 BAT 的软件/硬件 GPU 路径分别约 10.1 / 10.8 秒进入首页（含编译），隔离打包程序一次启动验收记录约 1.9 秒。测试期间同时有打包和其他验收进程，数据只代表本机采样，不是其他电脑的速度承诺。首页断言未启动伙伴/素材数据 Worker，未请求伙伴、素材、终端和世界的前端模块。153 项相关单元回归通过；实际文件导入、FTS5 搜索、托盘关闭、最近库及单选素材恢复、缺失最近库回退、双主题字体、多个世界窗口与聊天的独立验收通过。安装包由原有 `03-Build-Installer.bat` 完成，并对实际打包程序验收。

扩展伙伴回归仍有三项未通过：共同记忆修订后的列表刷新、日程便签刷新、用户头像裁剪确认。这些不计入本轮启动验收通过项，需要独立定位；不得把部分检查通过描述成整个项目全部通过。打包程序使用 `tests/e2e/packaged-startup.test.ts` 的真实原生对话框桩，不沿用仅开发版可用的路径注入快捷方式。素材恢复验收先退出导入的多选，再确认目标单选已持久化；显式点击模块导航后允许键盘焦点留在导航按钮。

伙伴世界还会显示实际形象资源计数，等待材质编译和首帧绘制。形象资源等待上限 20 秒，超过后显示可用画面和诊断提示，场景切换/关闭会取消旧等待。日志中的 `main.startup.phase` 保存每阶段 `durationMs` / `totalMs`，`renderer.startup` 保存界面及世界首帧用时。`02-Start-Development.bat` 在 Electron 启动前仍需 Forge/Vite 编译源码；这段开发冷编译不冒充应用内进度。无窗口验收默认跳过额外启动窗口，专用验收用 `WORLDLINEBOX_E2E_STARTUP_SCREEN=1` 并继续遵守隐藏窗口设置。
