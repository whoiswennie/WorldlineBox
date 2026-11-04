# 记忆系统的模型提供方

`lib/providers.cjs` 把记忆算法使用的 OpenAI Chat Completions/Embeddings 请求分到独立的聊天和向量提供方。默认聊天模型是 `https://api.deepseek.com` 的 `deepseek-flash`，可用 `CHAT_MODEL` 替换为实际部署可用的模型。DeepSeek 聊天配置不自动充当 Embedding 服务；向量必须来自明确配置的本地模型或其他提供方。

## 配置

| 字段 | 行为 |
|---|---|
| `CHAT_API_URL` | 聊天 API 根地址；默认 `https://api.deepseek.com` |
| `CHAT_API_KEY` | 只用于聊天上游请求，不写入源码或日志 |
| `CHAT_MODEL` | 路由实际使用的模型，覆盖原插件传来的旧模型名称；默认 `deepseek-flash` |
| `CHAT_API_TYPE` | `openai-completions`（默认）、`anthropic-messages`、`google-generative-ai` |
| `EMBEDDING_API_URL` | 文档向量 API 地址，支持独立本地 OpenAI-compatible Embeddings 服务 |
| `EMBEDDING_QUERY_API_URL` | 查询向量地址，默认与文档地址相同；适合 WorldlineBox 本地模型不同的 document/query 指令前缀 |
| `EMBEDDING_API_KEY` | 独立向量密钥，本地免密服务可省略 |
| `EMBEDDING_MODEL` | 向量模型；未指定时传递请求自身的 model，不生成假向量 |
| `CHAT_TIMEOUT_MS`、`EMBEDDING_TIMEOUT_MS` | 请求截止时间，默认各180000毫秒；也可用通用 `PROVIDER_TIMEOUT_MS` |
| `CHAT_MAX_TOKENS` | Anthropic/Gemini 摘要请求未指定 token 上限时默认8192 |
| `CHAT_HEADERS`、`EMBEDDING_HEADERS` | 对象类型部署标头；认证与Content-Type由适配器按协议设置 |
| `CHAT_COMPAT` | 对象类型；只用于 OpenAI-compatible，见下文 |
| `PROVIDER_MAX_BODY_BYTES` | 完整入站/上游 JSON 字节上限，默认32 MiB |

JS API 也接受 `config.chat` / `config.embedding` 对象，字段是 `{api,baseURL,apiKey,model,headers,compat,timeoutMs,maxTokens}`；向量对象额外支持 `queryBaseURL`。对象字段优先于大写配置字段。未显式设置任何 CHAT_* 或 chat 对象时，旧 `API_URL` / `API_Key` 作为通用端点兼容；只有该旧地址不是 `api.deepseek.com` 时才允许它同时提供向量。旧 `EmbeddingModel` 保留为向量模型别名。URL 必须是 HTTP(S) 且无内嵌用户密码、查询参数和 fragment，密钥通过请求标头传递。

不带 `/v1` 的 OpenAI/Anthropic 根路径会补 `/v1`，已有版本路径不重复。完整 `/chat/completions`、`/embeddings`、`/messages` 端点也可接受。Gemini 根路径默认补 `/v1beta/models/<model>:generateContent`。

## 协议范围

| 协议 | 支持范围 | 明确边界 |
|---|---|---|
| `openai-completions` | 非流式 Chat Completions 原字段透传；可处理上游支持的图像等内容 | 模型能力由实际上游决定；没有自动工具执行 |
| `anthropic-messages` | 记忆摘要的 text/system/user/assistant、temperature、top_p、token上限、stop；返回转为 Chat Completions | 非文本块、工具调用、额外未实现字段在联网前拒绝；不伪造思考链 |
| `google-generative-ai` | 记忆摘要的 text/system/user/model、temperature、topP、maxOutputTokens、stop；返回可见文本 | 不把 thought 当正文；无候选显式失败；非文本/工具块拒绝 |
| `openai-embeddings` | 文档/查询两条独立端点，原请求 input 等字段透传 | 上游必须返回真实非空有限数值向量；不使用 hash/随机回退 |
| `openai-responses` | 未实现，启动时 `UNSUPPORTED_API` | 不静默改用错误协议 |
| OAuth/Bedrock/Vertex/Azure特有认证 | 未实现 | 若网关能提供受支持协议，可作为该协议的自定义端点 |

所有路由拒绝 `stream:true`。记忆模块摘要使用非流式响应，流式聊天宿主不在此适配器范围。Anthropic/Gemini 的文本适配用于摘要和状态压缩；原始历史含原生 function/tool 元数据或多模态时，调用方应选择 OpenAI-compatible 端点，或先显式转换为完整历史文本。适配器不会悄悄丢弃字段。

`CHAT_COMPAT` 只实现当前所需的三个 DSH 式开关：`supportsDeveloperRole:false` 把 developer 转为 system；`maxTokensField:'max_tokens'|'max_completion_tokens'` 选择网关接受的上限字段；`thinkingFormat:'deepseek'` 使 `reasoning_effort:'off'` 显式发送 `thinking:{type:'disabled'}`，其他显式等级发送 enabled。未知兼容开关拒绝，不能把本适配器当作完整 pi-ai 能力目录。

## 宿主 API

```javascript
const { startProviderRouter } = require('./lib/providers.cjs');
const router = await startProviderRouter(config);
// router.url       -> http://127.0.0.1:<随机端口>
// router.queryUrl  -> http://127.0.0.1:<随机端口>/query
// router.key       -> 仅该实例使用的随机本地授权密钥
// router.capabilities 不包含真实上游密钥
// router.resetDiagnostics() 清空本次观测窗口
// router.getDiagnostics() 返回真实HTTP诊断的独立拷贝
// 完成后 await router.close()
```

入站仅接受已鉴权 POST `/v1/chat/completions`、`/query/v1/chat/completions`、`/v1/embeddings`、`/query/v1/embeddings`。两个 chat 地址到同一聊天上游，两个 embeddings 地址分别到文档/查询上游。原始 VCP RAG 可把 API_URL 指向 queryUrl；KB 文档索引的 apiUrl 指向 url，无须更改原算法的查询/文档前缀处理。

随机 loopback key 与上游 key 分离。提供方每次调用只发一次请求，**无自动重试**；HTTP 状态保留，错误正文截断并遮蔽已配置凭据。超时或调用方断连会取消上游请求。关闭 router 会取消待处理请求并释放监听端口。上层原 VCP 算法如自带重试，其策略仍由原算法拥有。

`getDiagnostics()` 只记录实际发起的upstream HTTP操作：endpointType、api、实际model、HTTP status、success/error、稳定errorCode，以及由performance.now()实测的独立hostTiming。原 `usage` / Gemini `usageMetadata` 按提供方原字段原样保留，不换算成推测token；向量只报告实际count和各条dimension长度，不保留数值向量、请求正文、响应正文、URL或密钥，也不计算质量分数。请求在本地校验阶段就失败时没有upstream记录，不能伪造一次网络耗时。reset后get返回空列表，返回拷贝的修改不会影响router内部记录。hostTiming是宿主测得的网络往返时间，和原提供方usage指标分开。

## DSH 参考证据与差异

只读参考项目：`C:\Users\hp\Desktop\project\deepseek-harness`，revision `639ed015397290b3745d163aafe02ffee4aa3f84`。参考了根/文档/包级 AGENTS 与以下真实实现：

- `packages/llm/llm-pi-ai/src/provider.ts`：显式协议表，手动路由主要为 openai-completions、openai-responses、anthropic-messages，默认展示 OpenAI-compatible。
- `packages/llm/llm-pi-ai/src/config.ts`：baseURL、api、apiKeyEnv、headers、timeoutMs、compat 的边界验证。
- `packages/llm/llm-pi-ai/README.zh.md` 与 `docs/user/guide/providers.zh.md`：提供方/模型/协议独立、兼容开关按协议消费、缺配置显式失败。
- `packages/llm/llm-deepseek/src/models.ts`：当前源目录存在 deepseek-flash 与可替换模型目录；`messages-api.ts` 避免重复/v1。

这里采用其路由和显式兼容设计，没有移植整个 Harness，也不复制其 OAuth、pi-ai目录、Cordis profile热加载或默认五次重试。当前记忆宿主配置在 router 创建时捕获，不在同一请求中切换；修改配置后新建 router。Gemini 是本模块额外的文本适配，不冒称它属于 DSH 手工协议表。

协议字段同时核对了[Anthropic Messages](https://platform.claude.com/docs/en/api/messages)与[Gemini generateContent](https://ai.google.dev/api/generate-content)官方接口。Anthropic采用显式 `anthropic-version:2023-06-01` 保持该已知版本契约；部署需要其他版本可通过 headers 覆写。

## 验证

`node --test tests/providers.test.cjs`：14个本地 HTTP 集成测试通过。覆盖聊天/文档/查询独立凭据与地址、DeepSeek缺向量诊断、legacy配置、Anthropic/Gemini请求与可见响应、兼容参数、未知字段拒绝、无重试、限时取消、loopback鉴权、HTTP状态、凭据遮蔽、query chat别名与完整JSON字节上限，另验证诊断usage原样、失败记录、真实向量shape、遮密、拷贝和reset。测试使用本地提供方替身，不宣称完成真实DeepSeek、Anthropic或Gemini付费API验证；真实DeepSeek和WorldlineBox验证由集成运行单独记录。
