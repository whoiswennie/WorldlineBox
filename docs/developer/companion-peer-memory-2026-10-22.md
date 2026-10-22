# 伙伴通信记忆与回忆凭证验收（2026-10-22）

## 修复的实际问题

真实模型回归确认：伙伴间正式消息已进入消息、实际参与者观察记录和记忆收录队列，缺失发生在后续日记提交。模型将新发生的“姐姐来询问玩家姓名”关联到同一伙伴早先的私聊姓名日记，日记校验和存储校验仍以不同会话为由拒绝关联，报错 `新日记不能关联其他来源域的旧记忆。`。结果是新经历没有提交和索引，之后只能召回旧的姓名介绍。

现在同一伙伴可关联自己当前有权读取、版本有效的旧记忆；其他伙伴的记忆仍不可直接读取。新日记的直接证据仍须来自实际发生的同一来源域，保留消息、观察者、校验和、版本、遗忘和撤回校验。已知答案不等于重复经历：新的有意义询问、参与者及回应结果可被选择性记录，重复寒暄和没有变化的确认仍可跳过。

历史修复采用一次性、有上界的重新评估：仅重排符合条件的旧伙伴空结果任务和已退役的跨会话限制失败，要求原始观察者、来源版本和当前授权仍有效；已遗忘或已有依赖历史不会被自动复活。

## 可检查的后台契约

- `social.reply.progress` 返回每个伙伴回复任务的宿主阶段：准备上下文、检索记忆、生成回复、等待发布及终态。完成后的正式消息携带 `replyProgress`。
- `social.reply.memory.inspect` 读取进行中任务保存的实际回忆凭证；`messageId=jobId` 仅标识该次任务，不创建草稿消息或学习来源。读取前后均复核租约，取消、替换或过期的尝试不能继续显示旧凭证。
- 已完成的伙伴回复使用现有 `reply.memory.inspect`，返回当轮保存的具体上下文、记忆版本及可追溯来源，不重新检索或调用模型生成说明。来源、版本或授权失效时脱敏。
- 仅保存宿主阶段和送入模型的记忆上下文，不公开模型隐含思考。普通通信可以独立于睡眠等物理作息处理；未激活伙伴、来源和发布校验仍生效。

## 世界信息与事件时间

自动日记不应仅因天气、温度、光照、位置或忙闲快照刷新而生成长期记忆；有意义的变化、感受和实际事件可带发生日期保留。此规则不删除真实历史。

事件叙述使用该消息持久化的历史世界时刻和时区，不拿当前世界钟替换旧事件。没有当时的时区凭证就不猜上午或下午。模型填写 `occurredAt` 应采用带时区的绝对时间，不能把仅供叙述的本地时间当作绝对时间。

## 验收证据与边界

完整交接回执为 [peer-episode-review.json](../../artifacts/vcp-validation/peer-episode-review.json)。初始失败和诊断保留在 [peer-episode-real-initial.json](../../artifacts/vcp-validation/peer-episode-real-initial.json)、[peer-episode-real-diagnostic.json](../../artifacts/vcp-validation/peer-episode-real-diagnostic.json)，修复后的实际结果为 [peer-episode-real.json](../../artifacts/vcp-validation/peer-episode-real.json) 和 [peer-episode-real-final.json](../../artifacts/vcp-validation/peer-episode-real-final.json)。`artifacts/` 是本地验收产物目录，未随仓库版本跟踪。

真实验收使用隔离的 SQLite 资产库、三名已激活合成伙伴、实际配置的聊天模型、内置 Gemma 和未修改的原版 VCP。先产生玩家私聊姓名，再产生姐妹的正式问答，经过实际选择性日记和原生索引后，仅以新的追问验证召回：两名参与者各自形成经历，妹妹能回答姐姐问了什么及自己的回应，未参与的第三名伙伴不能读取这次交流来源。最后一次实际回归也将先前把 UTC 小时误写成“上午”的行为纠正为记录中的本地 17:47。

这证明了该场景的收录、索引、跨入口本人召回和来源隔离，不代表所有对话或人类记忆语义均已验证。实际回归直接使用正式消息入口和真实模型/记忆链；完整世界调度、租约、阶段与检查端点另由存储和 WorldService 回归覆盖，Electron 界面验收另行记录。

最后一轮相关五套回归曾通过 117 例，之后受影响三套通过 71 例；最终迁移存储套件为 20/20，窄提示套件为 41/41。这些集合重叠，不能相加。测试入口包括 [companion-peer-episode-real.test.ts](../../tests/worker/companion-peer-episode-real.test.ts)、[companion-social-store.test.ts](../../tests/worker/companion-social-store.test.ts)、[companion-memory-model.test.ts](../../tests/unit/companion-memory-model.test.ts) 和 [companion-reply-memory-inspection.test.ts](../../tests/unit/companion-reply-memory-inspection.test.ts)。

最终统一构建上的 [companion-social.test.ts](../../tests/e2e/companion-social.test.ts) 三例 Electron 验收通过（1.2 分钟），日志为 [peer-social-electron-verified.log](../../artifacts/peer-social-electron-verified.log)。验证了未激活拒发、停用取消且重新激活不补发、进行中回忆详情、睡眠期间独立回应、三人群聊的实际身份及正式回复进度和回忆详情。测试通过界面明确选择全部伙伴和所有日期，避免将目标会话错误限定在默认日期。该组使用可控聊天服务且无已索引材料，回忆面板应诚实显示没有长期记忆原文，不能把它当作真实模型语义回归。截图为 [进行中回忆](../../artifacts/vcp-validation/concurrent-learning-ui/social-pending-context.png)、[私聊](../../.tools/test-output/companions/verified-social-phone-private.png)、[群聊](../../.tools/test-output/companions/verified-social-phone-group.png)。

仍需关注的语义风险：最后一次真实答案额外声称“当面问”，但保存文本仅证明联系，没有证明物理到场；模型也曾给出不带时区的 `occurredAt`。针对两点增加了窄提示及单元回归，没有再据此宣称普遍修复或迁移旧时间字段。长对话分批收录可能分别记录询问和回应，应继续观察冗余程度。原版 VCP vendor、本轮无关网络改动均未由该修复修改。
