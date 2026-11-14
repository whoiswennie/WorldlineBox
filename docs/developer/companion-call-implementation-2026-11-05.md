# 伙伴会面与聊天资源改造 · 2026-11-05

> 历史记录。当前视频会面使用独立 DSH 话题，通过桥接器的 call_stage 和 call_present 驱动 Live2D 与分段文字。旧版云端语音合成及其依赖已移除，本地语音识别仍可用。

## 当前会面桥接协议

- 在 `public/companion-call/models.json` 为伙伴登记模型配置和动作目录。Main 将目录与 Cubism 模型清单核对，再把可用的表情名、动作 ID、时长、参数与相对资源路径注入该话题的 DSH 请求。没有模型的伙伴使用头像和相同的气泡协议。
- `call_stage` 返回当前目录。`call_present` 接收有序的 `segments`，每段包含 `text`，可选 `expression`、`motion`、`gesture` 和 `durationMs`。桥接器按调用顺序提交，回执中的 `segmentIds` 对应已持久化的片段。舞台可以在模型完成前开始呈现。
- 模型使用 `call_present` 时，按工具提交的顺序和动作参数呈现。当前回合成功结束且尚无会面片段时，应用把 DSH 已提交的最后一条助手正文加入同一队列，使用默认姿态和现有分页。发布沿用当前事件授权和幂等标识。思考、工具结果和未提交的文字留在 DSH 内部。此过程无需再次请求模型，也兼容 DeepSeek 思考模式。
- `durationMs` 表示最短展示时长。舞台同时满足文本阅读时间和动作时长，再自动切到下一段。长文本的分页共享同一段动作，不重复触发。将来可用片段 ID 关联实时语音的进度与取消。
- 打断时保留已经开始展示的片段，移除其余片段并停止同一话题中的执行。历史记录保留已呈现内容，普通私聊使用自己的 DSH 话题。

## 对话归属

伙伴私聊头部的拨号按钮打开会面窗口。会面只是一种聊天呈现：沿用当前 conversationId、伙伴身份、原有 message.send、流式事件、任务、VCP 与历史消息。未增加模型客户端、Agent loop、会话房间或独立汇报上下文。挂机后消息仍在原私聊中。

会面采用 Galgame 风格：铺满窗口的环境与居中的伙伴，左下姓名、细分隔线和对白直接叠加在底部柔和渐变上。完整聊天记录和形象操作按需展开，标题、通话按钮和声音控制收为角落工具。没有固定聊天侧栏，不通过不透明的左右列或上下条带分割环境。默认半身和缩放仍由真实 Live2D 舞台控制。

底部轻量的“说点什么”入口可展开原来的唯一 `BotComposer`，绝对悬浮于场景上；已有草稿和待发附件会继续保留。表情、表情包、文件、录音语音、语音转文字、任务跟进均复用原组件、草稿、附件队列和发送逻辑；普通聊天底下不另留第二份输入框。“连续语音对话”只是标准工具栏的一项，会面中的普通录音与连续采集互斥。识别出的连续语音只提交本句文字，不隐式发送或清空用户正在编辑的附件；显式点击原发送按钮才按原规则提交完整草稿和附件。任务、记忆和完整历史工具继续使用原私聊面板，入口会提示返回私聊；会面内的聊天记录开关直接展示同段消息。对白有独立的视口定位：输入框展开、收起或多行增高不推动台词、背景或角色，只改变输入浮层自身。收起控件使用统一 SVG，位于原输入框内部。Escape 先关闭表情、录音、展开输入或记录设置，最后才结束会面。

会面复用 BotMessageBody 和现有附件服务；链接交给 Application 的内置浏览器入口。附件预览在会面之上打开，Escape 先关闭附件。聊天卡片、正文链接、Markdown 附件中的链接都通过 browser.request(tab.new) 打开；失败显示错误，不回退到系统浏览器。原文件的明确“系统打开”操作保留。

## 拨号与形象

- 点击拨号播放用户提供视频的前 26 秒音频，循环等待用户点击接通。60 秒未接自动结束；静音不重新从头播放。接通、取消、挂机和组件卸载清理播放器和计时器。
- 接通后显示沉浸式全窗场景，伙伴居中，原生对话组件与控制悬浮其上。保留文字输入，新增显式开启的连续语音对话；不使用摄像头。
- 内置 builtin-dafeiyu 使用用户提供的 DeepSeek Live2D；其他伙伴沿用各自头像和名称。模型失败时明确提示并保留聊天。
- 默认半身取景（1.9 倍），保留快捷放大、缩小、全身切换，操作页还可调整大小。缩放随视图高度重算偏移，保持头部可见。
- 完整挂载归档中的 23 个原生表情、8 个原生动作；支持点头、摇头、眨眼、视线跟随、待机、姿态滑块和原始姿态恢复。按用户要求删除摸头按钮及点击模型触发固定回应。原生表情与动作控制其自身参数，避免与本地情绪动画互相覆盖。
- SoulLink 引擎持续维护情绪、姿态、眨眼、呼吸、视线与语音表演。待机不依赖新消息，鼠标焦点短暂接管后释放，自然过渡回待机。普通文字的脸红和笑容降低幅度，不重演打开会面前的旧消息；不会自动切换体型、服装或道具。实际音频结束后释放语音层，保留短暂的情绪姿态余韵；恢复默认才明确清除情绪残留。

## 连续语音与错误恢复

识别复用本项目已有 `window.worldlinebox.localSpeech` 与 SenseVoice INT8 CPU 模型，不新增 ASR 服务或 Agent loop。`CallVoiceCapture` 薄适配共享 `VoiceRecorder`：至少 250ms 有效语音，随后静音 1 秒结束，也可以点击“说完了”；每句最长 60 秒。录音转换为 16kHz 单声道 PCM16 WAV，只请求 `speech.transcribe`，识别后的文字通过同一 `message.send` 发送，不为会面持久化原始录音或额外创建房间。拨号、接通本身不会开启麦克风。

`BotCallVoiceSession` 管理准备、聆听、识别、等待伙伴、朗读、失败与关闭。Main 返回该条消息实际创建的 `replyMessageIds`，`useBotCallVoice` 等待这些回复及整条音频队列结束，不能用其他主动消息、后台任务通知或初始 idle 状态恢复麦克风。识别与伙伴朗读时停止录音；TTS 准备期间同样关闭麦克风。用户可“打断并说话”、关闭语音或随时打字；打字取消旧录音识别并继续同一语音轮次。取消、挂断、换人、卸载均废弃旧异步结果、请求、录音轨道和计时器，不发送残余录音。

旧版曾采用云端朗读与音频驱动口型，这条链路已经移除。

场景中只保留一处当前台词，姓名和消息不在其他角落重复。台词绑定实际播放的 messageId，按音频 `currentTime / duration` 展开当前分段的完整 Unicode 字素，再累加已播放片段；这属于按播放进度展示，不声明逐词时间戳或音素标注。暂停、缓冲和未知时长不推进，结束后保留完整台词，后续排队回复不能抢占当前一句。字幕展示约 11Hz 更新，真实音频波形仍逐帧送入 Live2D。长台词只在实际朗读增长时跟随滚动，静止时可自行回看。原完整 Markdown、链接、文件与双方消息在按需展开的历史中保留，可手动重听。

合成网络失败、无音频、解码失败与播放失败均结束当前朗读并显示原因和“重试朗读”。每条失败保存到本次会面有界列表，后续消息继续排队朗读，不因上一条错误被静默丢弃；成功完成 ID 同样有界保留，避免迟到发送回执被后续任务通知覆盖。重试只重新朗读已存在的回复，不重新调用主脑或创建聊天消息；成功片段可复用有界缓存。语音轮次失败时麦克风暂停，用户可以重试朗读后恢复聆听、继续说话、编辑识别文字或继续打字。只有未确认发送的识别文本提供“重试发送”，沿用原 requestId；已经接纳的消息禁止当作发送失败再次发送。关闭麦克风也不会把已经发出的文字误报为未发送。没有无限自动重试，也不会因一个音频失败阻塞普通文字对话。

Edge TTS 需要网络；本地语音识别不需要将音频发送至云端。合成只提交已确认的伙伴回复文字。未配置语言模型时仍会显示原聊天回复失败，不把固定演示文字当作真实伙伴回复。

## 脸部异常的根因

实际模型有 49 组 clipping mask。参考适配器默认只初始化一个 Cubism 蒙版图，其容量是 36 组。超限后不同面部图层共用蒙版区域，出现整片红脸、白色鼻块和错误嘴部。实测脸红和嘴部参数均为零时仍可复现，故不能仅调整表情解决。

本地适配器在第一帧前读取实际蒙版组数：超过 36 组时按每图 32 组分配，当前模型分配两图；蒙版图提高到 1024 像素。真实模型截图已核对自然肤色、正常鼻部和嘴部。回归同时覆盖 49 组复杂模型需要两图、小模型保持单图、销毁释放。相关适配器版本和改动见 vendor/soullink-emotion/UPSTREAM.md。

Pixi 的严格 CSP 适配采用其官方提供的 [@pixi/unsafe-eval](https://api.pixijs.io/@pixi/unsafe-eval.html) 解释执行实现；JavaScript eval 仍关闭，仅为本地 Cubism Core 开启 wasm-unsafe-eval。

## 本地资源与复现

SoulLink engine、live2d-pixi 的本地源码快照保留 Apache-2.0 许可，`npm prepare` 编译本地包。私人构建使用用户已获取的模型 ZIP 和两段音频。Vite 在私人构建中复制 4096 纹理和模型运行文件，并使用菲比音频作为通用铃声、《Let Me Go》作为大肥鱼铃声。模型和两段音频存放在 Git 忽略的目录里。公开构建使用仓库提供的合成铃声，用户可在角色卡中导入作者 ZIP。Live2D Core 自带原许可头及链接。

```powershell
node scripts/stage-companion-call.mjs --model "DeepSeek免费公皮.zip" --ringtone "菲比.mp4" --dafeiyu-ringtone "Let Me Go.mp4"
$env:WORLDLINEBOX_INCLUDE_PRIVATE_CALL_ASSETS = '1'
npm run package
node scripts/inno-build.mjs --out out/private-call/installer
```

入口为 BotWorkspace.tsx，窗口为 BotCallWindow.tsx，形象生命周期为 BotLive2DStage.tsx。SDK 编译产物由源码重建。模型原画及拆分：神宫凉子；Live2D 建模：霓虹猫_NeonNeko，界面和本地模型目录均保留署名与原许可。

## 背景资产

使用内置 image_gen 模式生成；最终文件为 public/companion-call/scenes/evening.png。画面只有后墙、侧面窗灯和地板，无前景桌子，角色叠加不会站在桌子前面。也提供纯色场景和用户自选 PNG/JPEG/WebP/AVIF 图片，最大 2.5 MB，保存在本机外观偏好中。

最终提示词：

> Production anime environment illustration for a companion character video-call scene. Widescreen landscape 16:9. Empty cozy evening studio, eye-level camera. CRITICAL: ONLY BACKGROUND SCENERY. There is NO table or desk in the foreground, no desktop along the bottom, no counter, no railing, no front-facing furniture, no foreground plants, NO objects crossing the central character area. The entire bottom of frame is an open wood floor with a flat rug, from wall to camera, visible unobstructed. The central TWO THIRDS is quiet open space and floor for compositing a separate full-body character on top. Put bookshelves ONLY against the BACK wall at the far right edge, a window with blue hour city sky at far left, warm indirect lamp at far side, quiet violet and slate blue walls, small books and distant potted plants at far side edges only. Delicate original anime background painting, tasteful cozy atmosphere, soft balanced light, clean calm composition, refined high quality. No people, no characters, no animals, no text, no logos, no watermark. Do not draw any foreground furniture.

## 验证证据

本机隔离 Electron 使用真实 Core、模型和音频解码，逐一调用 23 个表情及 8 个动作，核对默认半身、缩放、26 秒铃声、接通停止铃声、原私聊消息归属、附件预览层级和挂机清理。60 秒未接结束与重试幂等由可控时钟单元测试覆盖。未进行付费自然模型质量实验；隔离环境未配置模型凭据时会如实显示回复失败。

此前聊天与外观基础回归为 119 个文件、895 项通过，12 个文件中的 14 项按环境条件跳过；后续语音与连续表演整合回归为 126 个文件、933 项通过。外观专项还覆盖旧偏好启动恢复、显式关闭透出后的重启保留，以及实际截图像素在面板透出开关前后的变化，证据见 meeting-final-unit.log、continuous-voice-unit.log 和 ui-resources-final-e2e.log。

本轮语音接入与 Galgame 改造另有独立验收：真实 Chromium 模拟麦克风 → 本机 SenseVoice → 原私聊 App 主脑/VCP → 音频播放/口型 → 再次聆听，确认不创建新会话、不保存会面录音附件。语言模型使用 localhost 协议测试服务；远端 Edge 音频替换为独立留存的晓伊 MP3，另有真实联网合成中性文字的证据，不能把协议测试服务的固定回答当作自然模型质量证据。强制合成失败后手动重试不增加聊天消息、不增加主脑请求，也不清空草稿。详见 call-voice-composer-e2e.log 和 ui/companion-call-voice-evidence.json。

Galgame 原生窗口验证真实 MP3 的逐步台词、暂停 350ms 后媒体时钟与文字均保持、结束全文停留、后续队列不抢台词，以及音频实际 RMS 驱动的口型峰值（约 0.167）。另核对 light/dark 场景、按需历史、唯一原输入框、表情/录音弹层、草稿收展保留、统一 SVG 控件及展开/多行/收起前后对白位置不变。详见 call-galgame-e2e.log、call-galgame-fixed-caption.log 和 ui/companion-call-galgame-evidence.json；本轮专项单测、类型检查与 ESLint 日志分别为 call-voice-final-unit.log、call-voice-typecheck.log、call-voice-lint.log。

本轮修复已执行项目 Windows Installer 脚本，生成 `out/make/inno/WorldlineBoxSetup.exe`。成品语音验收、字幕/口型/外观修复、Git LFS 模型远程校验及安装包摘要见 [后续修复记录](./companion-call-refinements-2026-11-05.md)。
