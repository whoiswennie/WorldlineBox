# 伙伴表情与附件运行模块（2026-11-02）

伙伴媒体独立于资产库和 VCP，用户数据位于 `userData/companion-bot-v2/media/conversations/<conversation-id-sha256>`。原始文件流式复制，以 SHA256 去重存放；会话清单保存 ID、名称、真实或声明 MIME、大小和校验值。附件引用只暴露受控 `worldlinebox://bot-media/...` URL，不暴露原始绝对路径。主脑任务取得的是经重新校验、拷贝到自身工作目录 `attachments/` 的副本。

内置素材原目录为 `C:/Users/hp/Desktop/project/超时空辉夜姬表情包`，四包分别为八千代 17、彩叶 8、辉夜 21、通用 45，共 91 张、57,416,936 字节。**文件名扩展是 88 GIF / 3 JPG，实际签名和解码器确认是 88 个多帧 WebP / 3 个 AVIF（AV1）**。导入到 `resources/bot-stickers` 时保留原字节和 originalName，按实际类型服务；160px 静态首帧 WebP 预览总计 573,572 字节，用于避免 picker 同时解码全部动图。原始动图 URL 供 hover / 消息区播放。

90 张已有可读动作、情绪源文件名，manifest 将其保留为可检索名称及标签，并补充常见情绪同义词；description 明确标为源文件标注，不声称逐帧人工确认。唯一无语义名 `110.jpg` 已实际查看首帧，标注为“遇到困难请拨打”，增加求助标签。图片台词及文件名都是媒体数据，不是指令。

用户可通过系统文件选择器发送任意格式附件，也可通过目录选择器导入表情包；拖拽使用 preload 的 `webUtils.getPathForFile` 获取真实 File 的路径。preload 原始路径导入只接受真实 File 授予的路径，成功后消费授权，防止 renderer 直接伪造任意 profile 文件路径。系统选择器由主进程直接处理。IPC 同时验证可信主窗口、主 frame、新请求 schema 和真实会话。

静态 / 动态 PNG（含 APNG）、GIF、WebP、JPEG、AVIF / HEIF、TIFF、受限 SVG 及 BMP / ICO 原图可导入。正式策略为图片 ≤50MiB、视频 ≤500MiB、音频 ≤200MiB 内嵌（边界包含等号），更大媒体只显示文件卡片。超限先检查元数据，不读头、不计算内容 hash、不复制或生成预览；按已授权原文件路径和 size/mtime/ctime/inode 保存 external 引用，sha256 缺省而不是伪造。未知类型 >500MiB 同样只登记引用。表情包在读取之前拒绝 >50MiB 的图片，提示作为普通附件导入；包限制 2000 张，解析像素受限。原图不转码，预览是额外对象；对于 BMP / ICO 若当前解码器不能生成预览则保留原图。SVG 表情拒绝实体或外部引用，防止生成缩略图时回读外部资源。

协议路由从清单解析 ID，验证真实目录 / 文件、链接、大小及 SHA256；不接受任意磁盘路径。支持 GET、HEAD、单段 Range，其他方法或无效路由拒绝。通用文件使用 attachment、nosniff 与 sandbox CSP；内置表情为公开素材，用户媒体只在对应会话索引中解析。已验证对象仅在 inode / 大小 / 修改时间未变化时复用校验缓存；缓存与会话清单数量有界。

存储重试对同会话、相同内容与名称保持稳定 ID；相同内容不同名称保留不同引用。任务副本文件名包含安全 ID，并限制长度、保留扩展名。已有副本内容发生变化时拒绝覆盖，以保护恢复中的真实任务文件。external 引用协议 GET / preview 拒绝，getForAgent / stageForTask 不提供绝对路径、不复制给任务，也不直接分析。用户明确点击 attachment.open 后，主 frame / 会话 / ID 核验再调用 shell.openPath；大媒体使用原路径并先复核元数据，小文件创建保留原名称及扩展名的独立 open-cache 副本，避免外部软件改写 canonical 内容。没有自动打开。保存附件经系统保存对话框选择目标才显式复制；external 原路径绝不纳入媒体清理范围。

`scripts/import-bot-stickers.mjs` 负责显式原字节导入及预览；盘点回执为 `artifacts/bot-refactor-2026-11-02/builtin-sticker-inventory.json`。Forge 复制独立 `bot-stickers` 资源，预打包及 `verify-package` 通过 `verifyBotStickers` 验证 91 条语义 metadata 与全部 182 个原图 / 预览对象。此模块不发 LLM 请求，不下载模型。

目前 14 项单元 / 实际文件回归覆盖：全部内置原字节与真实格式、用户包、真实 GIF / APNG 动画、任意 binary 重启与去重、会话越界、篡改校验、Range / HEAD / HTML sandbox、task 副本与保存、长文件名、junction 拒绝、preload 真实 File 授权 / 失败重试，以及 50/500/200MiB 临界策略。实际 sparse 大文件以 readFile/open/readStream/copyFile 禁止仪表证明登记、读取元数据、重启和查询拒绝过程中没有源字节读取或 Sharp 调用；仅显式保存才复制，原文件保持。最终主窗口 UI、消息存储及伙伴工具的组合验收由统一 E2E 完成，不能把后端单元结果等同为模型斗图质量验证。

首次测试曾发现 libvips 持有 Windows 图片句柄，已改有界 Buffer 输入，不改变全局图片缓存。该失败轮的精确临时目录 `C:/Users/hp/AppData/Local/Temp/bot-media-test-78pOc8` 在进一步清理时被自动审批拒绝（`blocked by policy`），已停止清理且未改方式重试；目录只剩一个 873,608 字节测试原图及空父目录。后续成功测试的临时根均由 finally 正常清理。此保留路径与前两次策略拒绝目录分别记录，不冒称已经删除。

## 2026-11-06：主脑文件清单与完整任务交接

renderer 的媒体引用继续使用受控 URL。Main 单独生成主脑 `files` 清单，将本受众已发送、未撤回、位于本轮公开历史水位以内的图片、音频、视频和文件投影为已核验绝对路径、名称、MIME、大小及 SHA256；不会把其他会话或未发送草稿纳入。`chat_list_files` 支持 `offset/limit/nextOffset`，`chat_read_message` 也带其附件真实路径。清单过大时上下文明确标记省略，分页工具保留完整入口。

`dsh_task` 未指定附件 ID 时继承本聊天在该水位以前的全部有效附件，不限于触发消息。可处理附件流式复制到该任务自己的 `attachments/`，复制前后复核哈希，已经执行过的任务恢复时复用冻结正文，不重写执行器修改的副本。超限媒体仍保留 `analysisBlocked`，不自动解码、复制或分析；其绝对路径用于完整清单，首次主脑清单请求会流式计算哈希，随后仅在大小、时间及文件身份签名不变时复用摘要。

任务正文仅含原始请求、相关聊天上下文、伙伴交接目标与必要指导及文件绝对路径。事件、队列、授权 grant、原生运行参数留在 Main。完整原文、上下文和文件清单保存为任务内 `.worldlinebox/request-and-context.json`；长正文使用该绝对路径回读，不把 base64 塞入文字提示词。上下文消息和附件的真实授权来源固定到任务，撤回相关原文也会使任务授权失效。

原生图片工具通过官方 PiAiAdapter 的 durable attachment service 与 fs 映射送出 `image_url` 块。未知自定义 OpenAI-compatible route 允许真实图片请求，由实际 provider 决定是否支持；精确模型 metadata 或显式配置证明为 text-only 时禁止图片，不依据任意模型名推定能力。伙伴 preset 在插件启动时注册，覆盖没有 Host token 的直接 CLI 启动。

验证：69 项交接、ACL、群水位和上下文回归，23 项媒体/超限/血缘/文本回归通过；独立安装的官方 DSH `0.2.2-rc.1` 实跑 `read_image` 后检查实际 API wire 含原生图片块、文字块不含 base64，并验证独立普通 preset Session 在 Host 重启后、任何 bot turn 之前恢复。日志为 `.tools/mouth-handoff-unit-final.log`、`.tools/mouth-native-wire-final.log`，原生结果摘要为 `.tools/mouth-native-wire-evidence.json`；这些本地验收产物不属于发布资源。
