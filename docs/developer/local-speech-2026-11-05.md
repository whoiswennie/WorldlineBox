# 本地语音识别

WorldlineBox 使用 SenseVoiceSmall INT8 ONNX、sherpa-onnx-node 1.13.8 与 Silero VAD，固定 CPU 推理。模型、词表、VAD 共 241,357,257 字节。该模型与向量模型各自拥有独立进程，语音识别不占 GPU 显存。

## 用户入口

- 伙伴聊天保留原输入框，在工具栏增加“录音发语音”和“语音转文字”两个图标入口，用小浮层显示录音状态，不替换或放大输入框。点击开始、结束后确认发送；浮层获得焦点时也可按住空格说话，松开发送语音。Esc 取消并关闭浮层。转文字填入原草稿，由用户确认后发送；语音消息保留 WAV 原录音，显示播放图标、声波和秒数，转写在原语音下展开。伙伴接收的附件证据包含本机生成的转写内容。
- 会面窗口提供同一服务的语音转文字入口。只有主动点击“开始录音”才访问麦克风；结束、取消、切换聊天或关闭窗口均停止录音。单次录音最多 60 秒，后端另按实际采样数验证上限。
- 发送普通音频附件时，宿主在入队伙伴消息前逐个生成转写。音频文件卡也可以展开转写。会话权限在耗时识别前后重新检查，旁观私聊不能提交录音或调用附件转写。

## 长音频与内存

FFmpeg 流式输出 16 kHz 单声道 PCM16。宿主以背压逐段读取，每块最多 20 秒，优先在末尾两秒的低能量区切开。工作进程内部用 Silero VAD 分段，语音最长约 15 秒，并恢复首段起音前 0.3 秒。识别完成后才读取下一块，不累积整个文件的 PCM、全部音频切片或并发识别任务。连续讲话没有静音时仍按最大块长切开；SenseVoice 是离线识别模型，这不是逐字流式识别。

一个应用共享一个双线程 CPU 识别进程，最多接收三个操作并串行执行；取消当前推理会终止并回收进程，下一次按需重建。空闲五分钟卸载模型。工作进程每块后回收原生流包装对象；主进程退出时关闭识别及解码进程。录音只允许标准、最长 60 秒 WAV；长附件每次最多 2 小时、64000 字，并受 20 分钟操作截止时间约束，超限报告错误，不返回截断成功。附件仍遵循现有 200 MiB 分析上限。

## 本机实测

2026-11-05，在 Windows x64、Intel Core i9-14900HX、约 32 GB 总内存上，使用真实 INT8 权重和双线程 CPU 测得：

| 场景 | 耗时 | 工作集峰值 |
| --- | ---: | ---: |
| 模型冷加载 | 0.89 秒 | 约 354 MB 就绪工作集 |
| 官方 5.592 秒中文录音 | 0.20 秒 | 约 374 MB |
| 20 秒合成重复样本 | 0.57 秒 | 约 381 MB |
| 30 个 20 秒片段，累计 10 分钟 | 28.02 秒 | 约 393 MB |

10 分钟实验复用同一官方录音合成片段，用于检查持续推理内存，而非真实长录音准确率评测。峰值私有提交约 395 MB。数值仅涵盖识别子进程；Electron、向量模型和解码器另计。低端 CPU 的速度需要另测；建议为语音服务预留约 1 GB 内存，整机至少 8 GB 是应用部署建议，不是模型官方最低配置。原始本机记录在 `artifacts/local-speech/benchmark.json`。

## 验证与来源

`tests/unit/local-speech.test.ts` 检查录音上限、分块无丢失、背压、串行队列、取消和语音持久化。`tests/unit/bot-voice-input.test.tsx` 检查转文字不自动发送、失败保留录音、切换聊天取消旧请求及转写展开。`tests/e2e/local-speech.test.ts` 使用真实 Electron、本地权重、Chromium 模拟麦克风、真实媒体协议和 FFmpeg 检查完整链路。

DSH 源码参考本机 `deepseek-harness` 修订 `22ddee3792` 下 `packages/experimental/speech-to-text-sensevoice`：默认 `precision=int8`、`threads=2`，识别器与 VAD 均固定 `provider=cpu`。DSH 的约 1 GB 安装内存提示是估计，不能视为实测上限。WorldlineBox 的长文件解码额外采用背压分块，避免沿用完整录音一次性转换成 Float32Array 的方式处理任意长文件。

模型及配置依据：[SenseVoice 官方仓库](https://github.com/QwenAudio/SenseVoice)、[sherpa-onnx SenseVoice 文档](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)、[固定 ONNX 模型修订](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07)。模型、运行时和 VAD 各自的许可及来源随模型资源分发。
