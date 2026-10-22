# 本人认识与最新状态验收（2026-10-22）

## 实现边界

偏好、反感、价值判断及表达习惯保存在原有 VCP「自我认识」笔记中，附带本人原话、来源版本及适用条件；当前档案是这些笔记的有界投影，没有增加另一套知识库。玩家喜好、他人说法或教材内容不能仅凭被读到就变成本人立场。条件性反思必须关联实际读过的本人记忆及来源，梦中虚构不进入当前档案。

同一主题采用稳定的 `topic`，明确修订关联旧笔记 ID；宿主只核验同一伙伴、当前有效来源和精确归一化后的同主题，不做模糊匹配替换。旧原文保留历史，退出当前档案；遗忘新条目不会悄悄恢复已退役的旧立场。每次推理前重新读取当前有效档案，群聊投影不携带来自其他私聊的内容。查询默认最多 12 项、最多返回 24 项，候选扫描有上限。

正式收录或睡眠整合可以提出有证据的当前表达、关注点和非玩家情绪评价。状态桥接要求已保存笔记的真实 ID、版本、来源与租约；按正式版本幂等。较慢任务遇到较新的状态版本时保留笔记、跳过过时状态覆盖，并留下审计。修改或遗忘旧笔记仅撤回该正式记忆版本的状态贡献，不撤回同来源中独立的真实玩家交互评价。浏览、召回和学习发生本身不构成情绪奖励，不改作者设定的稳定人格。

## 三角色真实内容验收

最终回执为 [character-growth-real-catalog.json](../../artifacts/vcp-validation/character-growth-real-catalog.json)，SHA-256 为 `df56a55161e21f20f65a9a6d5200cf3e06f962eaedead5939843ff1acac20007`。使用隔离的临时 SQLite 资产库、实际配置的 `deepseek-flash`、随应用提供的 `embeddinggemma-2-compact` 与未修改的原版 VCP。正式消息、选择性日记、索引及被动召回均实际运行；没有将旧聊天全文塞入下一轮输入。此次事件和角色均为合成验收材料，不是用户真实历史。

| 伙伴 | 模型实际表达 | 实际 VCP 召回结果 |
| --- | --- | --- |
| 阿澄 | 「一个人的傍晚又想保持清醒时，我会更喜欢温热的淡蜂蜜水；不过有明确事情要集中精神的时候，我会更倾向浓咖啡」 | 返回 1 条本人笔记，保留两个适用条件，并明确区别玩家的浓咖啡偏好。 |
| 璃音 | 「我最讨厌被一句接一句地追问同一个问题……不过你提前说清楚事情急，或者隔一阵再问一次，我都能接受。」 | 返回 1 条本人笔记，保留紧急说明或隔一阵再问的例外，没有采用玩家喜欢被催问的习惯。 |
| 月见 | 「我更看重的是在合作里先理解、再核实地接受建议……只接受经得起检验、也不越过彼此边界的那部分。」 | 返回 1 条本人笔记，明确区分教材的「无条件接受所有建议」。 |

三次初始召回均 `degraded=false`。随后阿澄实际表达：「只在晚间、想安静坐一会儿的时候，我会更愿意给自己泡一杯无糖温茶」。新日记沿用「饮品偏好」，明确替代旧条目；当前投影只返回新条目，仍保留集中精神时浓咖啡的未改条件。实际后续答案为：「现在的话，我会更愿意在晚间、想安静坐一会儿的时候给自己泡一杯无糖温茶……要是需要集中精神做事，还是浓咖啡更合适——那种情况我没改主意。」VCP 上下文同时将旧选择标为早期历史、将新选择标为修订。

遗忘新笔记后当前投影为空，已替代旧条目未复活；未参与的璃音读取阿澄这些来源得到空结果。稳定人格在三个角色中均未变化。最终这轮 `captureFailures=[]`，真实验收 1/1 通过，测试 51.00 秒、runner 55.31 秒，日志为 [character-growth-real-catalog.log](../../artifacts/character-growth-real-catalog.log)。

## 保留的失败与修复依据

- 初始 [initial](../../artifacts/vcp-validation/character-growth-real-initial.json)、[diagnostic](../../artifacts/vcp-validation/character-growth-real-diagnostic.json)、[current](../../artifacts/vcp-validation/character-growth-real-current.json)：本人句子以「现在我」开头、日记分类或正文使用自然改写，被过严的格式检查拒绝。宿主现将明确提议归入自我认识，并补入已经逐字核验的本人认识及条件；原文归属校验保留，只容忍末尾标点差异。
- [normalized](../../artifacts/vcp-validation/character-growth-real-normalized.json)：实际回复曾无依据说「我这两天上火」。现增加通用约束：当下喜好不能捏造病痛、亲尝或过去事件，旧发言只证明说过。该提示不等于能够普遍保证语义真实性。
- [final](../../artifacts/vcp-validation/character-growth-real-final.json)、[provider-audit](../../artifacts/vcp-validation/character-growth-real-provider-audit.json)：无变化的 `stateProposal` 与提供方多余 JSON 闭括号。前者正规化为空提议；后者仍严格拒绝并走有上限的既有重试，没有用宽松解析吞掉畸形输出。
- [acceptance](../../artifacts/vcp-validation/character-growth-real-acceptance.json)：测试等待器错误地忽略失败任务，过早把旧投影视为最终结果。已要求失败计数归零并保留实际失败、尝试次数，最多三次，不隐藏失败。
- [retry-acceptance](../../artifacts/vcp-validation/character-growth-real-retry-acceptance.json)：模型把「饮品偏好」重命名为「晚间饮品偏好」且不声明替代，新旧并存。现向已有日记生成请求提供经宿主校验的当前主题目录，明确同主题沿用及替代规则，不增加模型调用，不用模糊主题合并来掩盖问题。最终验收保留了旧条目必须退出的严格断言。

## 交叉复核补充：迟到补录与遗忘

发布前复核发现了原先顺序用例未覆盖的缺口：先保存新认识B、再迟到补录旧认识A，遗忘B后A可能恢复为当前。现增加仅含归一化主题SHA-256、伙伴ID、来源序号和笔记ID的退役水位，不存认识正文或明文主题；B已被遗忘、元数据清除后仍能拒绝迟到A复活。更晚的真实新表达C可以重新形成认识，伙伴重置会清理水位。已有认识的一次初始化采用流式迭代与单一事务，不一次载入全部正文。

定向角色与轻量重置回归 **14/14** 通过，另有6条既有重型压力用例未在本轮重跑；包括两种补录/遗忘顺序、群聊不泄漏私有新版、未来新表达及实际重置清理。原始日志见 [character-retirement-watermark-tests-final.log](../../artifacts/vcp-validation/character-retirement-watermark-tests-final.log)。发现缺口时中止了尚未完成的安装包构建，修复后重新运行三号脚本。界面验收也加入正式旧来源补录与当前档案不复活的断言。

## 最终验证与限制

冻结生产代码后的相关七套回归为 **140/140**，包括自我档案归属、条件性反思、替代和遗忘、私聊/群聊投影、正式状态整合、旧任务覆盖保护及模型输入；TypeScript 与 17 个相关文件的 ESLint 均通过。日志分别为 [validation](../../artifacts/character-development-frozen-validation.log)、[tsc](../../artifacts/character-development-frozen-tsc.log)、[eslint](../../artifacts/character-development-frozen-eslint.log)。这些测试与前轮集合重叠，不累加计数。

本轮真实日记没有提出状态更新，最终 PAD 为零，因此不能将本次内容验收描述为「真实模型已改变情绪」。正式记忆导致表达、关注点及 PAD 变化、修订撤回和较慢任务不覆盖新状态，由 [companion-memory-state-bridge.test.ts](../../tests/worker/companion-memory-state-bridge.test.ts) 的两条确定性回归单独验证。睡眠反思、梦境真实性和来源边界另由日记与梦境单元回归覆盖；没有声称本轮在真实模型中完成睡眠或完整长期生活模拟。

这是三角色、有明确追问的小样本内容验证，不是无提示自主成长质量基准，也不证明所有模态或所有长时运行均正确。主体、证据和版本检查能拒绝错归属，但不能单靠字符串校验判断本人每句话是否事实正确；最终例子中的浓咖啡与玩家存在重叠，也不能据此证明模型偏好形成完全独立。仍应关注无依据身体经历、摘要冗余和同义主题改名等语义风险。`artifacts/` 为本地保留的验收产物，不随仓库跟踪。

复现入口为 [companion-character-growth-real.test.ts](../../tests/worker/companion-character-growth-real.test.ts)，需通过私有配置提供可用聊天模型；日志不保存密钥、请求头或隐藏思考：

```powershell
$env:WORLDLINEBOX_CHARACTER_GROWTH_REAL = '1'
$env:WORLDLINEBOX_CHARACTER_GROWTH_OUTPUT = 'artifacts/vcp-validation/character-growth-real-repeat.json'
& .tools/node-v24.15.0-win-x64/node.exe scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/worker/companion-character-growth-real.test.ts
```
