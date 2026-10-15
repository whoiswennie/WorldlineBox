# 启动器交互与设置音乐验收（2026-10-13）

## 结果与证据边界

- 14 个单元测试文件、86 项测试通过，覆盖终端关闭、CLI 选择去重、市场与分享抽屉、全局模型保存、下载控制、并行版本注册和音乐持久状态。
- TypeScript 与 ESLint 检查通过。`03-Build-Installer.bat` 自身还执行主程序和浏览器扩展的类型检查。
- 实际 `02-Start-Development.bat` 验收通过：开发网页、原生 preload、工具环境自动加载、默认启动器和当前模块设置入口正常。新打包的 `WorldlineBox.exe` 再次启动验收通过，全局默认模型与音乐偏好通过真实 IPC 读取，音乐设置可打开且只有一个暂停的音频元素。
- `dsh-real-plugin-isolation.test.ts` 使用真实官方 RC.2 和 Alpha.2 程序，在独立临时用户目录中通过市场安装 `dsh-favicon-status@0.1.0-rc.8`，确认原生 WebUI 加载其资源、同版本和不同版本邻居不变、启停用与卸载有效、运行制品摘要不变，并运行和关闭真实 CLI 终端。记录在 `.tools/dsh-research/plugin-real-audit.json`。这个测试未模拟启动器 IPC 或 WebUI。
- `launcher-ui-feedback.test.ts` 用明确的启动器界面 fixture 验证布局和延迟响应；全局 LLM 文件与密钥加密仍由真实 Main 执行。该 fixture 不用于证明插件安装或原生 DSH 能力。

## 下载任务

暂停/继续由每个操作独立控制。HTTPS 字节流有背压等待门；固定 npm 子进程使用受管 IPC 暂停 HTTP 响应流，不暂停操作系统线程。IPC 在有活跃流时保活，在安装结束后释放，临时监控脚本在程序封存前移除。

原生 HTTP 测试让两个受管子进程并行下载：暂停 A 时实际消费字节保持不变，B 持续下载；A 恢复后继续，再暂停取消能回收子进程；B 正常完成。两个版本也并行生成和验证独立制品，并保留两个索引记录。重启后的未完成任务标为中断，保留可重试的版本/来源意图。跨重启会重新下载校验，不声明远端支持字节范围续传。

## 音乐播放器

移植 worldline-harness 的公开歌单、LRC/YRC 解析、同步歌词、播放模式与歌单管理，替换 Cordis 存储为应用用户目录中的 `music-player.json`。HTMLAudioElement 在应用根层常驻；设置页只挂载控制界面。首次配置默认暂停，歌单 ID 为 `18322613388`。每个歌单分别保存歌曲与进度。

`music-settings.test.ts` 使用本地生成的静音 PCM 与确定的元数据 fixture，真实播放、拖动/跳转、切换设置页及应用模块，验证同一音频元素持续播放；关闭并重启 Electron 后，真实 Main 保存的进度和音量恢复且保持暂停。这项测试不使用远程歌曲来模拟持久化结果。

`music-live-covers.test.ts` 不替换音乐 IPC、元数据、图片或音频请求：读取官方默认歌单 275 首歌曲，确认歌单和当前专辑封面实际解码（naturalWidth > 0），解析官方公开 CDN 播放地址，并静音播放后暂停。Electron fetch 的手动重定向取消问题改用 ClientRequest 的 redirect 事件处理，只取重定向头，随后仍校验 CDN 域名。

这段文字记录当时的真实音乐验收，历史回执和截图不随源码分发。运行 `node scripts/run-e2e.mjs tests/e2e/music-live-covers.test.ts` 可重新验收，截图写入本地忽略目录 `.tools/test-output/dsh-launcher/music-settings-live-covers.png`。远端公开歌单可能变化；记录不是固定目录或可播放版权保证。不可用歌曲由播放器跳过。

## 模型和提示

「设置 → 全局模型」独立于资产库保存 API 格式、地址、模型与加密密钥；默认 OpenAI Chat Completions / `https://api.deepseek.com` / `deepseek-flash`。资产语言和写入开关折叠为独立选项，保留用户已有连接。短结构化任务关闭官方 DeepSeek 思考输出，避免探测只有推理而没有最终内容。

普通结果用浮层，技能检查和整合包表单用抽屉；主列表加载前后边界保持不变。终端页签关闭按钮一次完成进程停止和移除，失败时保留输出。实例切换立即更新详情，CLI 准备不锁住其他导航。

## 打包工具副本

原工具锁与所有已锁定文件的 SHA-256 保持不变。Forge 按清单导出独立构建副本，验证并实际运行工具，再验证安装包复制结果。开发源目录中的额外 Python 字节码缓存保留，不纳入安装包，也没有被重新加入受信任清单。

自动审批拒绝了删除开发副本中的 `python/Lib/encodings/__pycache__/utf_8_sig.cpython-313.pyc`，理由为 `blocked by policy`。没有使用其他删除方式处理该文件。

实际 `03-Build-Installer.bat` 已生成 `out/make/inno/WorldlineBoxSetup.exe`（577,078,500 字节）。发布副本与最终包均通过原工具锁、文件树、SHA-256 和工具执行验证。
