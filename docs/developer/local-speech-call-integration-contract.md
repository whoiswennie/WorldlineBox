# 本地 ASR 与会面任务协作接口（2026-11-05）

共享 ASR 已可使用：模型资源 `resources/speech-models/` 的 241,357,257 字节已下载并逐文件校验，`sherpa-onnx-node@1.13.8` 已安装。CPU 原生推理、Chromium 模拟麦克风录音、语音持久化及媒体播放、78 秒长附件、运行中取消和重建均已通过真实 Electron 验收；基础相关单测 80 项通过。峰值约 393 MB，CPU 双线程。

稳定桥接：`window.worldlinebox.localSpeech.request(input)`，类型在 `src/shared/local-speech.ts`。不依赖 DSH Host 或向量模型。

- `{type:'speech.status'}` 返回 `status.phase`：unprepared/preparing/standby/loading/ready/transcribing/failed。
- `{type:'speech.prepare',requestId}` 检查离线资源；缺失时才下载固定校验的资源。返回 standby。
- `{type:'speech.transcribe',requestId,audio}`：audio 为标准 WAV 的 base64；返回 `{ok:true,transcript:{text,audioSeconds,engine:'sensevoice-int8-cpu'}}`。会面应使用此接口，成功后按原 conversationId 发送文字即可。
- `{type:'speech.voice',requestId,conversationId,audio}` 用于普通聊天的语音气泡，会额外持久化录音；会面无须使用此接口。
- `{type:'speech.cancel',requestId}` 取消录音识别请求。运行中取消会回收当前原生进程，下一次自动重建。请为每句生成新 requestId 并在挂断、换人、导航或旧录音失效时取消，忽略旧异步结果。

`VoiceRecorder` 在 `src/renderer/companion-bot/voice-recorder.ts`：`const recorder=new VoiceRecorder(); const capture=await recorder.start(onSixtySecondLimit); const recording=await capture?.finished; recorder.stop(); recorder.cancel();`。start 只等待麦克风就绪，finished 单独等待结束；结果 `{wave:Uint8Array,seconds:number}`，使用同文件 `speechBase64(wave)` 传给 ASR。录音及后端均强制最多 60 秒；原生推理内部仍以最多 20 秒分块。cancel 支持用户已关闭窗口后才获准麦克风的情况，会立即停止迟到的 tracks。不会访问摄像头。

视频会面继续复用本地录音与 speech.transcribe。转写结果进入当前会面话题，桥接器提供 call_stage 和 call_present，由 DSH 发布分段文字与 Live2D 指令。

已增加可选 `start(onLimit, options)`：`options.onLevel(level)` 返回 0..1 能量，`silenceSeconds:1` 在累计至少 `minSpeechSeconds`（默认0.3秒）有效人声后静音一秒自动 stop，随后调用 `onSilence()`。这是麦克风端能量端点检测；ASR 的 Silero VAD 仍在识别子进程内。监测只在指定选项时启动，停止或取消会关闭其 AudioContext。capture 额外包含 `startedAt` 单调时钟，原 finished/wave/seconds 不变。可直接复用，无须另写采集器。

普通聊天最新要求已澄清：原输入框布局保留，仅在工具栏增加“录音发语音”和“语音转文字”两个入口，用小浮层提示录音状态；QQ 参考只用于紧凑语音消息气泡及下方展开转写。本任务使用独立 `.tools/e2e-speech-app` 构建与验收，避开会面任务的 `.tools/e2e-app`。
