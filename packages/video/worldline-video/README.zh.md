# @deepseek-ai/dsh-worldline-video

[English](README.md) | 中文

这是一个用于健壮检查本地与在线视频的 Worldline 原生 Host 插件。它提供 `video_probe`、`video_index`、`video_read` 三个模型工具，以及内置的 `worldline-video` 工作流技能。

实现使用随应用打包的 FFmpeg/FFprobe 检查容器和抽取画面，使用随应用打包的 yt-dlp 获取公开在线视频的元数据、站点字幕并断点续传媒体。它不使用语音识别引擎，也不调用外部模型 API。没有内嵌字幕、同名字幕或站点文字字幕时，结果会明确标记为 `visual-only`（仅视觉分析）。

长视频只索引一次，清单位于 `~/.worldline/cache/video/<id>/manifest.json`。清单记录关键帧时间戳和约十分钟一段的章节；JPEG 只在读取指定章节或时间范围时按需抽取。即使面对数小时媒体，也能限制内存、磁盘抖动、工具输出和模型上下文。

在线视频的 `video_probe` 只读取元数据，不保存媒体。`video_index` 默认使用可断点续传的私有媒体缓存，以稳定分析长视频；可选的 `stream` 模式只保存元数据/文字字幕，并在读取采样 HTTP 范围前刷新直链。两种模式都必须传输实际解码的字节。登录、DRM、地区限制、反自动化验证、内容下架或过期链接仍可能导致公开来源不可用。

## 模型体验

### 视频工具与工作流技能

#### 模型看到的内容

模型可以看到 [`video_probe`、`video_index` 和 `video_read` 的 schema](../../../docs/tool-catalog.md#deepseek-ai-dsh-worldline-video)，以及 `worldline-video` 技能目录项；显式加载该技能后还会看到完整工作流正文。工具结果包含紧凑 JSON、可复用清单路径、带时间戳的 JPEG 路径和有界字幕文本。

#### Token 影响

三个稳定的工具 schema 和紧凑技能目录项会进入每次符合条件的模型请求；完整工作流只在模型加载 `worldline-video` 后加入，而每个视频的元数据、字幕和采样帧路径仅在相应工具调用后扩展当前轮次。

#### KV Cache 影响

未变化的工具 schema 和紧凑技能目录项构成稳定的重复前缀；加载或修改 `worldline-video` 正文会改变其后的技能上下文，每次工具结果只会追加会话内容，不会替换此前的前缀。

## 已知限制与后续工作

- 视觉分析依赖采样帧，并不代表连续播放了每一帧。
- 没有文字字幕时不会解释音频。
- 探测会报告图像字幕轨道，但目前不对其做 OCR。
- 内置原生可执行文件当前面向 Windows x64；其他平台会回退到 `PATH` 中的兼容命令。
- 在线站点可能比内置 yt-dlp 版本变化更快，届时需要通过后续安装包更新。
