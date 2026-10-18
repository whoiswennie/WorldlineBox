# 平台与媒体增量复核

## 固定来源和边界

独立对照上游 `03c99c0b..7a94cabc` 的 Linux/媒体/打包增量，复核主集成 agent 的当前工作区实现。未整文件覆盖、未修改主集成运行源文件，未安装系统服务、Docker、WSL 或其他系统环境，也未启动 GUI、构建、打包或提交 Git。

| 项目 | 当前源码证据和处理 |
| --- | --- |
| 原生构建门禁 | `forge.config.ts` 支持 `darwin-arm64`、`win32-x64`、`linux-x64`、`linux-arm64`，目标必须与宿主操作系统和架构一致；移除 arm64 prePackage/postPackage/preMake 免校验分支。保留 Windows portable tools、自动化声明生成、命名、签名与自有资源门禁。 |
| 媒体平台 | `scripts/media-binaries-lib.mjs` 允许 linux-arm64，当前平台解析与文件命名、必要文件清单、来源和执行校验仍统一。`sourceLockForPlatform` 按目标隔离新增平台的来源信息，避免添加 arm64 后使未变化的 Windows/macOS 受控包失效；目标自身与全局来源变化仍必须被拒绝。 |
| 媒体本地构建 | 新增 `scripts/media-build/linux-arm64.sh` 及 `resources/media-binaries/vcpkg/triplets/worldlinebox-arm64-linux-static.cmake`。脚本原生 Linux aarch64 检查、锁定 vcpkg commit、arm64 pkgconf、静态库 triplet、禁用远程二进制缓存、归档与 manifest 校验和均与上游相应逻辑匹配，产品前缀保持 WorldlineBox。 |
| 源码和依赖验证 | `scripts/media-build/stage-vcpkg-bundle.mjs` 对两种 Linux 架构读取平台 FFmpeg 源锁并做 Linux 动态依赖检查；source-lock 新增 arm64 的 FFmpeg 8.1 锁，不改 Windows/macOS 的现有来源值。 |
| AppImage 构建 | `scripts/appimage-docker.sh` 按宿主 x86_64 / aarch64 选择 Node 包；`scripts/make-appimage.mjs` 使用已有架构分支、WorldlineBox AppDir/desktop 名称与资源路径。Docker 是同架构基线构建，不等于交叉编译。 |
| 发布门禁和命名 | `scripts/release/lib.mjs`、`pipeline.mjs`、`publish-media-bundle.mjs`、`verify-package.mjs` 不再跳过 arm64 媒体；本地 arm64 构建路由正确。AppImage 发布名仍为 `WorldlineBox-linux-x86-64-<版本>.AppImage` / `WorldlineBox-linux-arm64-<版本>.AppImage`。保留 `WorldlineBoxSetup.exe` 与自有 Windows 制品流程。 |
| sqlite-vec | `scripts/sqlite-vec-integrity.json` 新增上游固定的 linux-arm64 SHA-256；包校验仍按目标架构检查，不能以 x64 二进制替代。 |
| linux-x64 媒体锁 | 只将本平台升级至上游 `media-v0.1.3`：归档 SHA-256 `8dc6e4d16228bfe78296686344f2e10bf259fa1924f5e1cf83a4a23aa6f40784`，manifest SHA-256 `f48a561ad2e358efd9a82e95c0ba6221638ea4226c012831b1cdfa79018366ab`。保持原始受信字节与上游 URL，不为替换内部来源文字而改二进制。 |
| Windows/macOS 媒体锁 | 保留原有数字 release ID、归档/manifest 哈希、`upstreamManifestSha256` 和 `brandingTransform`；不把上游 bundle-lock 整体覆盖成本项目锁。 |
| linux-arm64 发布状态 | 当前与参考上游一样为 `build-required`，没有已晋升可下载包。脚本、校验路径和锁状态同步完成；正式媒体晋升和原生 AppImage 发布未完成，不能宣称 arm64 已发布或实机通过。 |

没有发现相对上游本部分的运行逻辑漏项或旧实现回退。原 AppImage maker 和发布重命名已经包含架构分支，因此上游相关注释变化不要求重复引入业务代码。复核发现媒体 README、八份中英文开发/用户平台文档仍遗漏 Linux 或只有旧白名单，已局部更新；未移植上游 README，也未改原有 Windows 安装说明、启动诊断、AI 文本/多模态分析说明。

## 本机可复现证据

- `artifacts/serpent-031-platform-environment.json`：2026-10-19 01:02（UTC+8）检查，主机 Windows；`Get-Command docker`、`Get-Command bash` 均未找到命令；系统存在 `C:/windows/system32/wsl.exe`。
- `artifacts/serpent-031-wsl-list.json`：`wsl.exe --list` 返回 1，提示“未安装适用于 Linux 的 Windows 子系统”。仅查询，没有执行安装命令。
- `artifacts/serpent-031-update-media-extension-unit.log`：主集成已有 4 文件 / 82 项通过、5 项平台条件跳过。它们是跨平台门禁/媒体配置/更新与扩展测试，不等价于 Linux 内实际运行媒体或应用。
- `artifacts/serpent-031-platform-audit-unit.log`：独立执行 `node node_modules/vitest/vitest.mjs run tests/unit/linux-release-gates.test.ts tests/unit/media-binaries.test.ts`，2 文件、13 项通过、5 项平台条件跳过。
- 新增功能性回归 `tests/unit/linux-release-gates.test.ts`：调用实际媒体 CLI 的 `acquire` 和 `ensure`，在 arm64 `build-required`、自动获取开启且 `WORLDLINEBOX_MEDIA_SKIP_PROVENANCE=1` 的本地试验设置下，仍在读取传入归档前拒绝，未写入媒体制品；调用 Forge 的真实 prePackage 钩子，跨平台/架构打包在启动媒体工具前拒绝。测试不联网、不构建、不启动 GUI。
- `artifacts/serpent-031-platform-audit-lint.log`：新增测试 ESLint 通过。

## 未验证的范围

本机没有可用 Linux 执行环境，故未运行 shell 语法工具、vcpkg 媒体构建、AppImage maker、Linux native 模块、媒体二进制或桌面 UI。不能继承上游的 Debian/X11/嵌套 Wayland 测试结论作为 WorldlineBox 自身验收。还需原生 Linux x64/arm64 按本项目门禁构建，检查 GLIBC 2.35 基线及实际系统依赖，并分别验证 X11/Wayland、GPU、文件浏览/导入/媒体预览和截图录屏权限。arm64 还需先晋升媒体包，才能进入正式发布验收。

这些平台限制已如实写入安装、环境与故障排查文档。Windows 实际 BAT、打包版和远程交付由主集成独立验收；本子项的静态/单元结果不能替代该流程。

## 固定 x64 归档实物核验

主集成期间另行下载了锁定的 `media-v0.1.3/serpent-media-linux-x64.zip` 到隔离工具目录，没有修改活动资源。实物为 38,037,946 字节，ZIP SHA-256 与 manifest SHA-256 均完全匹配锁；manifest 的 8 个文件哈希通过。3 个二进制均为 ELF64 x86-64，解析版本依赖表得到最高 GLIBC 2.35；OIIO 还要求 GLIBCXX 3.4.30 / CXXABI 1.3.13，因此仅检查 GLIBC 不足以保证任意发行版兼容。项目 `verifyBundle({execute:false})`、来源锁比较、归档路径与可执行权限也通过。报告见本机 `artifacts/serpent-031-linux-archive-validation.json`。这仍是实物与静态验证，没有执行 Linux 二进制或应用。
