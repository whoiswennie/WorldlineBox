# Windows 启动器的便携工具

安装包携带 Node.js 24.15.0、npm 11.12.1、pnpm 11.7.0、CPython 3.13.12（完整标准库、pip 25.3、ensurepip、venv）、Git for Windows 2.48.1、FFmpeg / ffplay / ffprobe 8.0.1 essentials。Node 24 满足 DSH 官方 `^22.19 || >=24` 的运行约束；构建工程仍使用自身固定的 Node 24。

工具内容位于 `resources/portable-tools/win32-x64`，属于忽略的二进制构建输入。`resources/portable-tools/tool-lock.json` 是可审查的清单哈希锁；清单记录所有文件大小和 SHA-256。Forge 打包前按原锁清单导出至 `.tools/portable-release/<构建 ID>/resources`，逐项核对原文件及导出文件的字节，再实际运行各工具。开发目录额外生成的缓存保留在原处，不更新锁文件，也不进入安装包。最终包验证再次检查完整文件树；缺失或改变任一已锁定文件仍会使打包失败。

开发入口的 `ensure` 仍核对每个已锁定文件，只允许额外存在由清单内 Python 标准库模块派生的 `__pycache__/*.cpython-313.pyc`，避免正常运行生成缓存后无法再次启动。显式 `verify` 与安装包验证继续要求文件树完全一致，发布副本不含这些新增缓存。

首次准备构建输入执行 `npm run tools:stage`，或给脚本明确的便携发行版展开目录：

```powershell
node scripts/portable-tools.mjs stage --node C:/path/node-v24.15.0-win-x64 --python C:/path/Python313 --git C:/path/PortableGit --pnpm C:/path/pnpm --ffmpeg C:/path/ffmpeg-8.0.1-essentials_build
node scripts/portable-tools.mjs verify
```

当前本机离线来源为用户已有的相同版本 CPython / Git 的程序内容、工程固定的 Node 与官方 DSH 包中的 pnpm，以及用户指定的 FFmpeg 构建。准备过程只复制工具文件，不启动安装程序，不读取用户凭据，不写 Windows 安装注册表或系统 PATH。Python 只带标准库和固定 pip，排除用户额外安装的第三方模块；Git 排除卸载程序和用户系统配置。重新准备其他工具版本必须审查版本约束和新锁文件。

`resolvePortableTools()` 在开发目录与安装包 resources 中使用同一布局，校验编译进程序的清单哈希及入口程序。`portableToolEnvironment()` 只为子进程添加工具 PATH、Git 自有 CA 和执行目录，移除外部 PYTHONHOME / PYTHONPATH；完整 CPython 通过自身路径查找标准库。没有强制设置 PYTHONHOME，实例创建的 venv 可以正常生效。

`tests/unit/portable-tools.test.ts` 实际验证最小系统 PATH 下的 Node、pip、Python venv、Git 本地仓库复制以及三种媒体命令。Python 包含的 pip.cmd 使用相对路径，不带源机器的 Python 安装路径。旧工程的资产媒体 bundle 仍独立管理，不被这个 GPL 命令行工具包替换。

发布来源与许可证见根目录 `THIRD_PARTY_NOTICES.md` 和随工具包 `SOURCES.md`。公开分发 GPL Git / FFmpeg 构建时须一并提供其对应源码和所启用依赖的源码；工具清单并不替代这项分发义务。
