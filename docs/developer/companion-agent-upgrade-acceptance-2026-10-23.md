# 虚拟伙伴 Agent 与话题升级：验收记录

本报告只把实际执行过且满足内容断言的项目列为通过。真实自主现实协作、后台日程/工作单、八人伙伴群聊、长游戏及话题管理均已通过；保留原失败报告，并逐项记录修复后的复验结果。

## 结果与证据

| 验收层 | 已检查的实际结果 | 证据 |
| --- | --- | --- |
| 真实原生 DSH | 简单文件410；CSV汇总400；同session续用增加一行后475；另一伙伴在独立目录复核475；真实文件/JSON内容逐项核对 | `.tools/test-output/companion-dsh-real-agent-acceptance-final.json` |
| 真实原生能力目录 | 安装版0.2.1rc2实际工具完整schema、完整技能分页拼接、commands与native CLI help；零模型调用 | `.tools/test-output/companion-dsh-capability-describe-native.json` |
| 生产 Broker 复用 | 同一官方 CLI 进程、不同独立 Agent/session/cwd；已测warm启动31/49/64ms，cold约7.95s，模型与工具总耗时另算 | 同首项；不能把此项当作完整启动器链路已经通过 |
| 真实主脑→DSH | 林澄实际选择执行方式和工具，汇总104.5并生成随机标识JSON；周岚实际读取原CSV和结果，在独立目录再次生成review JSON并比对 | `artifacts/companion-agent-acceptance/main-dsh-content.json`；此项用户脚本顺序@两人，不冒充自主协作 |
| 真实自主现实协作 | 仅一条用户任务交给林澄；林澄模型自行选择world.collaborate，周岚独立模型接受授权、在自己的消息端口/主脑/DSH目录重算，林澄读取核验结果后继续实际生成交付；4行CSV总额18430分，analysis/review/handoff/summary四份真实文件逐项验证 | `.tools/test-output/companion-autonomous-collaboration-content-acceptance-final.json`与`-final-files/`；79.64秒；0.2.1-rc.2；没有第二条用户委托、原生subagent冒充或模型HTTP错误 |
| 真实后台入口 | schedule.kind=task与正式work-order分别进入独立runGoal，由实际主脑选择DSH创建随机标记JSON并读回核验；父状态done/completed，实际invocation.kind与messagePort正确，没有混入另一聊天canary | `.tools/test-output/companion-background-dsh-content-acceptance.json`与`-files/`；35.34秒；两项执行与discovery共用实际CLI PID36260；模型HTTP错误0 |
| 真实PTC | 安装版0.2.1-rc.2以ptc执行read/write/present组合，模型实际只得到run_code；读取17、23、19并生成总额59的随机标记JSON，结构化交付verified=true | `.tools/test-output/companion-dsh-ptc-content.json`；9950ms；不是只检查schema或把native当PTC |
| 角色内容 | 三位不同角色在同一群分清自己、姐妹关系、朋友与真人天幻岚；实际peer作者切换；独立消息端口无其他会话sentinel | `artifacts/companion-agent-acceptance/role-content.json` |
| 真实伙伴记忆 | 原配置实际模型、原生VCP处理自己确实见过的姓名；另一伙伴真实询问、正式回答和回忆；旁观者拒绝访问 | `artifacts/vcp-validation/peer-episode-real.json` |
| 八人真实伙伴群聊 | WorldService真实领取9个任务、实际在线模型9次、正式完成9次：七位收件人各自回应、发起者一次汇总、模型明确指定的一次后续；8位作者身份正确，同话题/参与者范围正确，无旁观者私聊或另一话题canary，无错误/DSH/外部工作 | `artifacts/companion-agent-acceptance/peer-group-content.json`；23.67秒；初始发言和加入为host fixture，后续全部经过真实social调度；空记忆fixture不冒充此项VCP召回 |
| 八伙伴长游戏 | deepseek-flash实际144次模型调用，其中52次摘要调用；90次实际玩家决定；同话题连续两局：第一局4天好人胜，第二局3天狼人胜 | `artifacts/companion-agent-acceptance/topic-werewolf-content.json` |
| 游戏切换与恢复 | 首日暂停全部参与者，普通聊天只回答17+25=42，没有游戏消息/动作；关闭并重开SQLite，恢复原局、私态与药剂；第二局重新分牌；每份模型请求不含其他玩家ACL token | 同游戏工件 |
| 真实模型管理话题 | 私聊中Alice自行创建长篇小说话题并更新本人工作状态；伙伴群中Alice/Bob各自创建独立话题，Bob通过真实world原生调用自愿加入、按名称搜索；另一伙伴私态canary未进入请求 | `artifacts/companion-agent-acceptance/topic-native-content.json`；13.02秒；初始消息与邀请为fixture，实际创建、加入、查询由模型选择 |
| 话题原生接线 | 真实SQLite与WorldService，受邀Bob先收到邀请端口，模型原生world.topic.join调用后重新装配A历史与本人私态；B话题和Alice秘密均不在wire；正式回复仍归A | `tests/unit/companion-world-service.test.ts`的voluntarily join用例；模型为确定性夹具 |
| 话题管理与隔离 | 每reader指针/个人暂停、邀请自愿加入、source固定、私态ACL、重启、after/before分页、标签名称搜索、删除后不重分类ordinary、宿主水位防伪 | `tests/worker/companion-topics.test.ts` |
| 话题Renderer | 当前发送目的地独立于历史浏览；话题草稿/异步附件隔离；分页搜索、标签、邀请/加入/退出、编辑、派生、暂停/恢复、结束/重开、显式删除，无归档 | `.tools/test-output/companion-topic-renderer-acceptance.json`；55项纯Renderer测试通过，Electron完整接线另验 |
| 话题Electron实际接线 | 实际Main/Renderer/SQLite，无存储mock；私聊与群聊创建、邀请、自愿加入、用户/伙伴不同目的地、私态隔离、历史不改发送目的地、暂停恢复、重命名/标签搜索、52条真实分页与删除原绑定均通过 | `.tools/test-output/companion-topic-ui-native.json`；此项未配置在线模型，不把UI邀请接线视为模型自主邀请能力 |
| 大量话题 | 真实10000话题，连续5页每页50项、250项无重复；关键词模糊命中20，标签页50项；实测分页查询组合92.39ms | `.tools/test-output/companion-topic-scale.json`；不把250项分页读取说成读取或渲染全部10000项 |
| 父目标与证据 | 日程与工作单不因首个DSH子步骤成功自动完成；所有实际调用槽位有终态记录，成功修复保留失败尝试；独立主脑最后交付与当前授权相符才完成；租约续期与过期恢复同一父目标 | `tests/worker/companion-goal-completion.test.ts`、`companion-schedule-state.test.ts`、`companion-work-order.test.ts`、`tests/unit/companion-autonomy-service.test.ts` |
| 长任务跨边界恢复 | 实际Main服务与SQLite配确定性provider：先实际推进70个工具调用，在第71次模型请求中关闭并重开Store/Main，继续到85个工具调用及最终第86turn；前70turn完全一致且call IDs无重复；provider近期assistant历史不超过32；原工作单完成 | `.tools/test-output/companion-long-loop-acceptance.json`：2文件7项通过；不是声称在线模型已跑85步；另130份实际存储action凭证逐slot验收通过，避免最近100条UI窗口漏掉早期成果 |

## 游戏内容验收的实际边界

裁判是测试夹具，负责公布规则、发放身份、校验动作和判胜；邀请与最初加入也是夹具设置。玩家发言、夜间选择、投票和摘要全部来自实际在线模型。此项验证通用话题上下文与角色决策，不声称产品内已经内置狼人杀规则引擎或完整游戏UI。

为在有限时间内实际触发多次压缩，测试使用14条消息的小窗口、80%阈值、至少3条原文尾部；生产默认256条/480,000字符、80%阈值、约16%且至少32条尾部。原始日志不删除，压缩只更新该读者自己的工作checkpoint。两局均在6个游戏日上界内按公开规则结束，没有脚本替玩家选票。

先前失败已用于改进：摘要缺stage或JSON无效时，现在在相同来源上有限纠正，未形成有效摘要绝不推进水位；第二局曾发生把新队友当旧局目标的非法提案，宿主未执行该提案，同一调用接受合法候选反馈后自行重新决定。52次摘要与90次决策的最终成功记录没有跳过失败来伪造胜负。

自然语言推理与策略不是确定性正确性保证。验收硬约束是身份和输入范围、秘密ACL、实际状态、合法动作、胜负与可恢复连续性；公开游戏诈身份属于策略，不等于伙伴真人身份改变。

## 自主现实协作的修复与最终通过

保留 `.tools/test-output/companion-autonomous-collaboration-content-acceptance-baseline.json`、`-scope-fixed.json`、`-history-fixed.json`，均不能列为通过：

1. DSH收到整段主脑组合目标，原生子代理冒充另一位伙伴生成审查。主脑实际识别该结果不是另一伙伴本人，验收拒绝。现TaskSpec只传本次子目标与显式context，宿主保留原文限制性短句，不自动注入整个用户任务或全部附件。
2. 联系人多词查询被误作完整子串；修复为实际名称/ID多词匹配。DSH不承担世界联系人查询。
3. VCP版本变化清掉所有工具历史，导致重复执行；修复为来源/能力分类的证据撤回，持续保留真实行动状态与DSH回执。
4. 受邀伙伴真实接受grant并进入独立主脑后，身体电脑预约门仍只认同会话user来源；现已接通同一持久grant、原user source、受邀者、独立invocation与真实child port的核验链，普通peer不因此获得现实权限。
5. 证据撤回留下空assistant turn，供应商拒绝`content:null`且没有tool_calls的请求；现跳过空turn，保留完整DSH call/result与实际执行ledger。

最终第五轮从唯一用户任务开始完整通过，模型自主邀请、独立接受、独立主脑执行、原发起者继续汇总均有实际持久证据。协作完成与工作单/日程复用同一逐task-slot检查：每个执行步骤均需同目标真实终态，允许保留失败尝试再成功修复，拒绝遗漏并行task或全部失败。相关world/goal-proof/collaboration存储测试32项通过；不能用首个成功子任务提前结束父目标。

## 长任务连续性

原实现的`turns.max(64)`、草稿/流事件step上限和循环硬停会让恢复再次卡在第64步，现已去除生命周期步数硬限；每64步仅异步让出调度，取消、关闭与每步真实授权核验继续生效。持久原始turn与action slot编号完整保留，不靠重排或删除历史绕过验收。

模型每次接收近期完整call/result窗口与累计LLM工作摘要；默认32turn/240000字符触发整理，保留16turn附近的近期原文，摘要最多32000字符。这是历史装配策略，不是任务总步数或思考预算。单个不可拆的超大原生turn保留完整，不能为满足窗口数字截断签名/调用结果。当前persona、目标、权限、状态与最近32条宿主执行ledger每步另行重建；全部原始收据仍持久保存。

摘要绑定owner/conversation/source/invocation/topic/grant与证据撤回水位；输入先经过合法证据/世界/状态投影，不能把旧私态藏进摘要重放。无效JSON有限纠正，保存失败、来源变化或checkpoint变更均不推进水位。6项模块测试覆盖累计摘要、持久恢复、pending签名call保留、失败不推进与撤回secret重建。长任务测试采用确定性provider验证调度与存储，不据此保证任意长自然语言规划必然正确或无限期无人干预运行。

## 实际旧存档清理

用户已授权清除旧伙伴存档。最初对选中资产库内 `.worldlinebox/companions` 和 `伙伴记忆` 的递归删除被自动审批以`blocked by policy`拒绝，未通过换语言或其他等价目录删除绕过。随后改用更窄的产品正式重置、VCP invalidate/forget、记忆目录同步与正式隐藏空会话流程，实际旧业务正文已清空。

证据：`.tools/test-output/companion-real-domain-reset.json`，最初发现孤立世界端口漏清的失败报告另存`-first-attempt`。实际结果为messages16→0、social messages5→0、有效notes2→0、记忆正文2→0、生成时间线4→0、VCP视图4→0；15个联系人保留，重新打开后可见会话0，每个owner的记忆snapshot和旧来源读取均为空。40条历史note逐条确认只剩标准遗忘/失效文字，tags与sources为空、无旧metadata/sourceMessageId；40条正式forget全部完成。首次正式清理仅残留无正文的删除凭证；最终追时并全量重置后，VCP scope、视图和删除journal均为0，仅保留空profile运行目录。

额外发现世界cursor仍处于旧时段，可能让新生角色补跑旧活动。已使用正式world.tick追至2026-10-23 02:53:20（Asia/Shanghai），随后再次重置全部15位伙伴；3位活跃角色出生时间与当前cursor一致，世界事件、作业、工作与拜访均为0。此维护过程未添加产品兼容逻辑。

全局模型配置/密钥、DSH实例/运行版本/任务配置、资产库定位与原Assets元数据指纹在清理前后完全一致。该实际库的per-owner配置原本均继承全局，密钥文件为0条目，已额外核对未变化。运行目录、manifest和必要遗忘tombstones保留，不能把业务数据清理说成整个目录物理为空。修复的重置遗漏仅覆盖有宿主marker证明的本人精确隐藏world端口，不扩大到其他群或相似名称会话，另有两项SQLite回归。

完整启动器预热、首次实例文件监视、长期待机保温、实例插件技能实际启停删除均已通过，证据由`companion-upgrade-dsh-memory-acceptance-2026-10-23.md`维护。跨64步的持久恢复、摘要与全部执行凭证检查已完成；最新联合回归见下节。

## 最终回归与修复闭环

首次伙伴大回归发现39项失败，其中既有旧工具接口、旧短期窗口、旧身体独占认知通道的测试假设，也有公开NPC资料与图片投递、遗忘后旧世界工具正文重放等实际缺陷。测试更换为现行原生三能力接口和正确消息端口，实际缺陷修复后定向复验。

随后182个文件的大回归共1564项：1543通过、19项真实模型环境开关用例跳过、2项失败。该次长时间运行期间载入的service旧动态字段比较和130项proof旧持久实现，均在运行中完成修复；原失败报告保持原状，不覆盖为通过。最新4文件联合重跑93/93通过，覆盖service全部81项、goal-proof4项、摘要6项与长期/世界投影2项：`.tools/test-output/companion-loop-proof-regression-final.json`。两项失败已明确闭环，不能把该联合结果说成第二次单次全范围零失败运行。

真实SQLite的100000条消息和100000条来源日记重置压力用例也已通过。修复待重置日记索引和重置期间逐日记重算最终将删除的状态，保持单批低于1秒；最终大回归中实际处理93.58秒、最大单批727.35毫秒，含建数与重启核验的该用例117.63秒。证据：`.tools/test-output/companions/verified-companion-reset-pressure.json`。此项验证重置批处理，不冒充真实用户数据清理。

界面以实际Main/Renderer/SQLite再跑，检查1440与1040宽度的明暗主题，无水平溢出。`.tools/test-output/topic-ui-message-badges-dark-1040.png`同时展示真实游戏话题正文、日常正文与各自标记，浏览全部历史不会改变composer的游戏话题目的地。该UI测试未配置模型，排队回复卡不是伙伴实际完成的发言；真实模型角色、话题和游戏内容结果另见上表。

DSH相关73文件共342项首次被统一放到Electron Node模式下运行，出现23项运行器失败：复制的process.execPath实际是Electron可执行文件缺ICU、Node原始文件测试遇到Electron透明ASAR、测试子进程环境不同。没有为此添加产品兼容代码或改变原生ABI。将对应7文件交给实际安装版的独立Node24.15.0重跑，52通过、1项平台/环境跳过、0失败；按同名文件替换去重后为322通过、20跳过、0失败。原报告保留，归因与合并依据为`.tools/test-output/dsh-runner-diagnosis-final.json`。三个历史运行包的实际完整性和跨版本兼容性检查也已通过，耗时514.34秒；该耗时属于封存制品逐文件hash，不能说成伙伴每次DSH启动耗时。

## 多人交流与个人暂停的最后修复

旧peer群聊只给字典序首位收件人创建任务，四条总消息的硬上限使大群其他成员无法获得回应机会；单人`text=null`还会结束整条链。这不是八人脚本裁判能覆盖的机制，现另以实际WorldService群聊验收。每位真实收件人分别获得首轮参与或沉默机会，首轮终态后发起者最多一次汇总，再仅允许模型显式指定的一次后续，避免每条群回复产生N个新任务。私聊保留有限自然往返，不把多人饥饿当防止自言自语。

个人暂停不领取任务、不消耗重试次数；待发消息停止typing并保留原topic，其他topic继续。结束、删除或退出会精确取消旧任务，快速重开/重入不会复活已经取消的动作。重试耗尽是该成员的一项终态失败，不能永久阻挡其他人汇总。领取首轮时可纳入同话题已正式发布的最新消息，但来源与授权仍固定原邀请；领取后的readSet冻结。对应5文件63/63通过：`.tools/test-output/companion-topic-admission-regression-final.json`；额外八人真实模型结果见上表。

最终构建的Electron社会交流E2E另有3/3通过，耗时89.14秒：休眠拒绝与处理中取消、双人独立消息端口的原三次回应、群聊全员首轮及发起者汇总与唯一明确后续。严格核验author/source/replyTo和模型指定收件人，原工具副作用断言保留。此项模型为本地HTTP夹具，验证真实UI/IPC/调度接线，与八人在线模型结果分开记录：`.tools/test-output/companion-social-fair-e2e-final.json`。

受公开三能力协议影响的既有Electron E2E，另有5个唯一用例分轮复验闭环：文件/图像/附件、并行读取与取消重试、SSE工具续答与重启、状态日记/日历/提醒及明暗UI、朋友家沙发聊天与现实工作途中取消。前3项首轮通过，日记与世界路径分别修正旧fixture后定向通过，不合称单次5/5运行；原失败报告保留，去重依据见`.tools/test-output/companion-public-capability-e2e-summary.json`。

这些测试使用真实Electron/Main/Renderer/UtilityProcess/SQLite和当前协议，外部模型与工作执行器为明确夹具；不替代在线模型或真实DSH内容验收。仍断言真实状态增量、工具回执、图像输入与附件交付、取消清理。世界用例先激活伙伴、实际观察后移动就座，按当前独立场景核验离门路线、travel目标、玩家显式急扰后的跑动、抵达电脑ready前零执行、唯一执行，以及尚未抵达时取消并释放资源。没有为旧的强制跨park路径、沙发闲置必触发attention分类或旧runtimeState回执添加产品兼容代码。

## 启动延迟的实际边界

当前选择的实例保留一个已准备的待机宿主，闲置超过五分钟不再销毁唯一待机宿主；其他空闲宿主仍按上限清理。32次调用后的退役、崩溃、真实配置变化和模式变化仍生效，启动器只为当前实例补充，失败进入failed而非无限重试。fake clock的11分钟待机、改选、轮换与关闭测试通过；真实生产Broker轮换后40ms，实际built DshLauncher自动补充后下一能力调用159–160ms，证据`.tools/test-output/companion-dsh-launcher-standby-final.json`及`companion-dsh-selected-standby-native.json`。

首次实例还修复了profile目录尚不存在时watch安装失败的问题；现监视已存在的home并排除会话/缓存等噪声。相同内容写回不退役，真实配置变化退役；能力目录默认access与预热使用同一模式。普通聊天遇到warming/cold/failed实例直接将目录视为未知，不等待初始化，显式能力查询再等待真实结果。首次封存制品验证、宿主冷启动、配置变更/轮换、模型推理及工具执行仍分别计时，不能把预热后延迟保证套到所有阶段。

## 最终构建与静态检查

最终产品源码冻结后的完整隔离构建已于2026-10-23 02:52:15（Asia/Shanghai）通过，耗时12.514秒，覆盖Main、preloads、workers、plugin runtimes与Renderer：`.tools/test-output/companion-upgrade-final-build.json`及同名`.log`。该命令的Playwright阶段仅列出用例，不把列举当作测试执行；真正执行的E2E在各自证据中单列。

全量TypeScript主程序与extension检查、全部变更源码和测试的ESLint均exit 0，`git diff --check`无空白错误。其后的旧E2E接口迁移仅改测试，不再改变产品源码或重建运行制品。
