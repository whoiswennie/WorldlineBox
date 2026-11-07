# Windows 纯净仓库与三个入口脚本验收（2026-11-07）

源码来自 `https://github.com/whoiswennie/WorldlineBox.git` 的 `main`，验证目录为 `C:\Users\hp\Desktop\project\new\test-git`。开始时该目录不存在；克隆完成后的基线确认没有 `node_modules`、`.tools` 和 `out`。没有从原工作区复制这些目录、模型运行库或打包产物。系统已有 Git/Git LFS、Python 和 MSVC；这次是同一台 Windows x64 上的全新项目目录验证，不是重装系统或空白虚拟机验收。

首次 Git 传输遇到连接中断，重试后源码正常取回。GitHub LFS 的 554,821,120 字节 projector 传输长时间无数据，因此保留远程源码和 LFS 指针，完成 checkout，再由 `01` 从清单固定的上游地址分段重建并验证 SHA-256。其他已下载 LFS 对象来自该测试仓库自己的下载缓存。该过程没有用旧工作区的文件替代缺失资源；首次运行仍需要可用网络，本次显式使用 `http://127.0.0.1:7897` 代理。

## 修复内容

- `01` 显式构建伙伴 SDK，安装并验证独立 Node 24 VCP Memory，检查 Live2D LFS 还原状态，并准备语音模型、向量模型与 CPU/Vulkan 运行库。仅所有步骤成功后才写环境就绪收据，解决过去必须先打包一次才有记忆模块的问题。
- 增加受控 LFS 指针检测和恢复。已经还原的源码无需再次调用 Git；缺 Git LFS、还原失败或路径越界均有明确错误。
- Windows PowerShell 5 的 `Invoke-WebRequest -Headers @{Range=...}` 会拒绝 Range 头，且不会自动使用 HTTP(S)_PROXY。下载器改用兼容 5/7 的 HttpClient，显式转发代理，检查 206 和准确 Content-Range，限制每段写入大小及超时。PowerShell 5 实际代理下载和完整哈希校验通过。
- 首轮 `01` 在最后的 Inno Setup 下载发生两次中途断传后失败。通用下载器增加四次有界尝试：同一来源的网络中断可续传；换源、HTTP/Range 错误及哈希不匹配会丢弃原部分内容。修复后从远程拉取更新并重新运行完整 `01` 成功，保留了此前已验证的模型和工具。
- 固定 SDK 分发文件和自动化声明的 LF 行尾，避免 Windows 上重新生成后将 147 个内容相同的文件误报为修改。更新 checkout 后再次生成，工作区保持干净。
- 开发验收脚本将 DSH 根目录检查从旧 `dsh-launcher` 改为实际 `dsh`。首次真实 `02` 已在 55,827 ms 进入首页，之后因旧验收目录判断被拒绝；修正后的完整重跑在 12,013 ms 进入首页并通过所有断言。后者复用了开发编译缓存，不是首次冷编译速度承诺。

## 实际执行结果

| 入口 | 结果 |
| --- | --- |
| `01-Setup-Environment.bat -Proxy http://127.0.0.1:7897` | 完整重跑退出 0。新目录安装 1,285 个项目依赖；独立记忆安装并核对 246 个生产依赖和 Node ABI 137；便携工具 10,181 个文件、880,728,775 字节完整清单匹配；向量资源 105 个文件、875,022,906 字节；SenseVoice INT8/CPU 模型资源合计 241,357,257 字节；Inno Setup 就绪。 |
| `02-Start-Development.bat` | 由 `scripts/test-dev-bat.mjs` 调用真实 BAT，退出 0。确认没有安装依赖或重编译原生模块，默认启动器、真实 preload IPC、网络切换、亮暗主题、按需加载正常。使用独立临时用户数据，结束后自身进程树和测试数据均清理。 |
| `03-Build-Installer.bat` | 退出 0。类型检查、Forge 生产构建、实际复制资源和原生模块校验、Inno 编译全部完成。构建源码提交为 `0ce6839cd8678cc684f4154a16dd8b76e3ce6f51`；随后验收记录提交不改变应用源码。Inno 压缩耗时 1,079.766 秒。 |

安装包：`test-git\out\make\inno\WorldlineBoxSetup.exe`，版本 0.1.0，**1,723,471,382 字节**，SHA-256：

```text
43a88f9b0f6dd926fddd7401009e9fc3afc7fb9e9589b536788e1232174a91bb
```

## 测试

六个 Windows/LFS 回归文件共 **30 项通过**，在原工作区和远程测试仓库均实际执行，覆盖前置环境拒绝、依赖安装边界、伙伴运行时准备与逐阶段失败、LFS 恢复、PowerShell 5 代理/分段限制，以及断点续传和换源/哈希失败后的重置。TypeScript 与改动脚本 ESLint 检查通过。

直接指定新仓库生成的 `out\WorldlineBox-win32-x64\WorldlineBox.exe`，成品 E2E **6 项全部通过（57.2 秒）**：

1. 内置向量文件无需再次安装即就绪，模型设置在亮暗主题及窄窗口中正常。
2. Claude 通过真实 Main IPC 与 SQLite 初始化，角色卡中的新头像、立绘、三视图实际从 `app.asar` 加载；亮色 1440、暗色 1440/850 均通过。
3. 真实 CPU SenseVoice 离线准备、录音转写、可播放语音持久化、长附件转写及超限录音拒绝。
4. 成品程序启动并完成真实 Worker 文件导入。
5. 成品 FTS5 检索及筛选导入资源。
6. Windows 关闭按钮隐藏窗口并保留托盘进程。

本机日志保存在原工作区 `.tools/clean-checkout-*.log`、`.tools/clean-checkout-baseline.json` 和 `.tools/clean-checkout-installer.json`；开发验收记录位于测试仓库 `.tools/dev-bat-acceptance/2026-11-07T12-23-41-447Z-3ec5cec1-f3a6-4253-8f5e-2b7bbeddef50`，Claude 成品截图位于测试仓库 `artifacts/companion-claude`。依赖、日志、测试用户数据和安装包不作为源码提交。

## Claude 素材修订

根据用户更新的 670×1200 参考重新绘制头像、全身立绘及正侧背三视图，使用短而柔和的脸型、大琥珀色眼睛和安静表情，替换首版偏成熟的面部设计。头像和立绘保留透明背景，三视图使用干净白底。素材、用户原始参考、完整内置 image_gen 提示词、尺寸和 SHA-256 均保存在 `public/companion-bot/builtins/claude` 及其 `source-manifest.json` 中，已随源码提交远程。
