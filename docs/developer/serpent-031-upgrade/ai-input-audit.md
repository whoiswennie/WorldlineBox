# AI 资产输入与失败原因复核

本项复核保留 WorldlineBox 已有的文本资产分析增强，未用上游 0.3.1 图片分析实现覆盖它。

## 当前真实能力

| 资产 | 实际发送的内容与边界 |
| --- | --- |
| TXT、Markdown、JSON、CSV/TSV、日志、XML/YAML/TOML/INI、配置和常见代码文件 | `TEXT_EXTENSIONS` 中的格式通过 `readTextAsset` 读取正文并检测编码/二进制；最多读源文件开头 64 KiB，解码后再次限制为 64 KiB UTF-8。发送真正的文本消息，不把文本伪装成图片。超限标记 `truncated`，提示模型只分析提供的开头片段。空白和不可读二进制以 `AI_TEXT_UNREADABLE` 失败。 |
| 图片（媒体注册表支持的位图、RAW 等） | 有界视觉输入，默认最长边 2048 px；解码失败时尝试受管理的缩略图，不上传无界原文件。 |
| 视频 | 惰性准备并发送关键帧分镜/封面视觉输入；没有转写视频声音，不宣称已经阅读整部视频的全部内容。 |
| FBX、OBJ、glTF、GLB、STL | 使用现有四视图渲染合成图，属于视觉输入。 |
| PDF、Adobe Illustrator `.ai` | 使用现有首页预览图；请求明确告知模型只看到首页，不声称读取其他页面。 |
| MP3 等音频、Office、压缩包、可执行文件、HTML 等尚无 AI 内容提取器的格式 | 不上传二进制文件，不以文件名假装知道正文。分类为 `AI_INPUT_UNSUPPORTED`；批量任务全部无可用输入时 Main 返回 `AI_NO_ELIGIBLE_ASSETS`，尚未调用供应商。 |

纯文本可用纯文本全局模型。图片、视频分镜、模型视图和文档预览要求视觉能力；明确不支持视觉的模型提前返回 `AI_MODEL_NO_VISION`，未知模型由真实服务拒绝结果分类。OpenAI Chat、Responses、Anthropic、Gemini、DashScope 五种传输都已有文本消息分支，既有 Worker 测试通过 Main 入队、SQLite 队列、实际 loopback HTTP 和结果落库验证了 TXT/MD/JSON/Python，不只检查文件扩展名。

输入能力由 `shared/ai-asset-input.ts` 和对应 Worker 准备分支明确管理。未来增加音频/Office 等需要真实的提取器、相应提示和供应商内容传输，不能仅把扩展名加入清单就宣称可分析；本次未加入无关抽象，也未承诺全部文件类型。

## 本次发现与最小修复

1. **截图中的笼统 AI 提示有直接代码原因。** App 批量分析把普通 IPC `PublicError` 交给 `toMessage`；它只映射 `code`，把已有的具体 `reason` 丢掉了。`renderer/error-utils.ts` 现在对白名单原因使用和 `LibraryOperationError` 相同的本地化格式，保留“未配置”“没有符合条件资产”“模型不支持视觉”“文字不可读”“请求被拒绝”等信息，不展示任意供应商字符串。
2. **兼容服务的异常响应不应变成内部崩溃。** Gemini 的 null candidate/null part/非数组 parts、Anthropic 的 null content block 原来触发 TypeError，队列只能分类为 `AI_INTERNAL_ERROR`。现在这些响应得到明确的 `AI_INVALID_RESPONSE` 分类；Anthropic 空块之后的合法分析块仍可读取。
3. **DashScope 纯文本模型连接测试与分析路线不一致。** 分析已经为纯文本模型走 text-generation，连接测试仍固定走 multimodal-generation。现在两者使用相同的模型能力分流，文本探测发送字符串，视觉模型的文本探测使用原生多模态消息数组。

上述问题先用新增测试复现：provider 7 项、普通 IPC 提示中英 2 项在修复前失败；修复后全部通过。未修改 Main/App 入口、库迁移或自有模型配置。

## 验证

- AI 文本/协议/handler/错误/端点/配置相关单元测试：8 个文件、171 项通过。
- `tests/worker/ai-text-input.test.ts`、`ai-analysis.test.ts`、`ai-completion.test.ts`、`ai-video.test.ts`、`video-ai-input.test.ts`：5 个文件、93 项通过，使用 Electron 的 Node 模式，无 GUI。
- 本次 6 个变更源代码/测试文件 ESLint：0 错误、0 警告。
- 修复后的完整 `tsc --noEmit` 通过；主流程仍需对最终整合状态执行类型检查。
- 现有 `tests/e2e/ai-text-analysis.test.ts` 通过真实 Main/Worker/SQLite 和本地模拟供应商验证全局纯文本模型、正文上传、Inspector 描述和标签更新、无错误 toast 以及原文本不变。本分工不启动 GUI，实际运行结果由主流程补充。
