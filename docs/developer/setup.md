# 环境搭建

## 要求

- Node.js **24.15.0**（`.nvmrc` 锁定，用 `nvm use` 切换）
- npm（国内网络建议 `--registry=https://registry.npmjs.org`）
- 原生开发目标：macOS arm64、Windows x64、Linux x64/arm64；Linux 为预览支持，arm64 媒体包尚未晋升，不能直接生成正式发布包
- **不要在 SMB/NAS 挂载目录上构建或运行**——Electron 在挂载盘上无法正常启动（`icudtl.dat not found`），打包产物也不能从挂载盘运行

### macOS

- Xcode Command Line Tools（原生模块编译需要）
- 媒体组件构建（仅需要重建时）：`scripts/media-build/darwin-arm64.sh`（vcpkg，耗时数小时）

### Windows

- Git、PowerShell
- Visual Studio Build Tools：勾选“使用 C++ 的桌面开发”（Desktop development with C++）工作负载及 Windows SDK（原生模块 `better-sqlite3` 编译必需）
- **Inno Setup 6**（构建 Windows 安装包 `WorldlineBoxSetup.exe` 时必需）：
  - 推荐方式（免管理员）：通过 NuGet 获取 `Tools.InnoSetup`，解压提取 `ISCC.exe` 放置于 `%LOCALAPPDATA%\WorldlineBoxTools\inno\tools\` 目录；
  - 官网安装方式：安装官方 Inno Setup 6 并将环境变量 `WORLDLINEBOX_INNO_TOOLS` 指向 `ISCC.exe` 所在目录（或加入系统 `PATH`）；
  - 若仅在开发态运行（`npm start`）或生成便携版（`npm run package`），则无需安装 Inno Setup。
- 媒体组件构建（仅需要重建底层二进制时）：`scripts/media-build/win32-x64.ps1`（vcpkg）

### Linux（预览）

- 编译工具链与 Python（`better-sqlite3`）：Debian/Ubuntu 需要 `build-essential`、`python3`；构建媒体还需要脚本使用的 Git、CMake、zip、pkgconf 等工具。
- `npm ci` 不安装媒体包。linux-x64 的锁定媒体包为 `ready`（`media-v0.1.3`）；linux-arm64 采用相同获取/校验门禁，但当前为 `build-required`。开发时可用 `npm run media:ensure` 获取已晋升包；未获取时可从 PATH 使用可信 `ffmpeg` / `ffprobe`，专业图像格式另需 `oiiotool`。
- 原生 aarch64 媒体构建入口是 `scripts/media-build/linux-arm64.sh`；本地试跑与正式晋升步骤见[构建与打包](build-packaging.md#linux-appimage)。不能在 Windows 上交叉生成通过原生门禁的 Linux 包。
- AppImage 推荐同架构 `npm run make:appimage:docker`，基线为 Ubuntu 22.04 / glibc 2.35；无 Docker 时可本机 `npm run make:appimage`，但须检查较新系统引入的运行依赖。运行需要 FUSE 或 `--appimage-extract-and-run`；X11/Wayland 与截图录屏权限需实机验证。
- 常用变量：`WORLDLINEBOX_SOFTWARE_GL=1`（无可用 GPU 时软件 WebGL）、`WORLDLINEBOX_LINUX_ROUNDED_CORNERS=0|1`（强制直角/圆角）、`WORLDLINEBOX_FFMPEG_PATH` / `WORLDLINEBOX_OIIO_PATH`（可信工具路径）。

本轮未安装系统服务、Docker 或 WSL，也未在当前 Windows 主机完成 Linux 实机验收；平台支持和制品是否已发布以锁文件、发布页及验收记录分别为准。

## 首次构建

Windows 推荐使用根目录的 `01-Setup-Environment.bat`。脚本先用 `npm ci --ignore-scripts` 安装锁定依赖，再显式执行 `koffi`、`node-pty` 的安装钩子，最后只为 Electron 构建 `better-sqlite3`。这样不会先为系统 Node 编译一个随后被替换的数据库模块，也避免其头文件选择 ClangCL 后出现 `MSB8020` 或 LLVM 库工具的参数错误。

Electron 下载遇到连接重置等网络错误时会重试；GitHub 不可达时自动尝试 npmmirror 备用源，并始终按锁定 Electron npm 包内的官方 SHA-256 校验。有备用源时，curl 持续低速也会结束当前尝试并换源，避免看似连通却等待数小时。已有完整且校验一致的 ZIP 会复用，下载失败不会将半截文件当作安装包。也可以通过 `ELECTRON_MIRROR` / `ELECTRON_CUSTOM_DIR` 指定下载源；`02` 在 `01` 成功完成后启动，不负责补装依赖。

脚本会从固定 URL 和 SHA-256 的公开发行包自动准备缺失或版本锁已变化的便携工具，无需提供旧机器上的工具目录。完整逐文件清单、版本锁、下载配方和获取脚本都在 Git 中；二进制和缓存不进入源码历史。`git pull` 更新工具锁后，`02` / `03` 会在启动前提示重新准备。`01` 或 `npm run tools:repair` 先在临时目录验证新包，再切换并保留 `.tools/portable-tool-backups` 中的旧包，失败不覆盖旧目录。需要代理时运行 `01-Setup-Environment.bat -Proxy http://127.0.0.1:7897`；下载、组装和完整清单校验的规则见[便携工具说明](portable-tools.md)。

Windows 媒体包也由锁文件中的固定发布附件直链获取，下载后校验 ZIP、组件清单和来源；首次安装不需要通过 GitHub API 查询该附件，也不需要手动准备媒体 ZIP。

```bash
npm ci --registry=https://registry.npmjs.org
npm run rebuild:native
npm start
```

`rebuild:native` 把 `better-sqlite3` 编译为 Electron ABI 并实测 FTS5。Windows 上**不要**裸跑 `@electron/rebuild` 或 `node-gyp`——本机 vcpkg 的 MSBuild 集成可能链接到无 FTS5 的 sqlite3.dll；项目脚本已强制禁用。

## 媒体组件

`npm ci` **不安装** FFmpeg/ffprobe/OpenImageIO。缺组件时普通开发与图片导入不受影响；视频缩略图/代理生成会报 `FFMPEG_REQUIRED`，EXR/TGA/复杂 TIFF 需要 OpenImageIO。

打包产物使用受控媒体包（FFmpeg 8.1 LGPL-only + OpenImageIO 3.1.12.0），门禁校验产物哈希与来源（`bundle-lock.json` 的晋升状态 + `source-lock.json` 的版本匹配）。本地开发可用 `WORLDLINEBOX_FFMPEG_PATH` 指向任意可信 FFmpeg（需含所需滤镜/编码器，且 `ffprobe` 同目录；GPL 构建仅限本地覆盖）：

```bash
# macOS
export WORLDLINEBOX_FFMPEG_PATH="$HOME/tools/ffmpeg/ffmpeg"
npm start
```

```powershell
# Windows
$env:WORLDLINEBOX_FFMPEG_PATH = 'C:\tools\ffmpeg\ffmpeg.exe'
npm start
```

更换后需完全退出 WorldlineBox 再启动（单实例锁，二次 `npm start` 不会替换已运行进程）。

## 常见开发命令

```bash
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # 单元 + Worker 集成（Electron 内运行）
npm run test:unit        # 仅单元
npm run test:worker      # 仅 Worker 集成
npm run test:e2e         # Playwright E2E
npm start                # 开发启动
npm run start:multi      # 双实例
```

## 开发注意事项

- 测试跑在 Electron ABI 下（`test:worker`/`test` 经 `run-vitest-with-electron.mjs`）；`npm run package` 后需 `npm run rebuild:native` 恢复 dev native 模块
- `npm start` 自动避开被占用的 Vite 端口
