# 多伙伴能力与任务重构验收

日期：2026-11-06。对应长期目标和方案见 [实施计划](companion-capabilities-refactor-plan-2026-11-06.md)。本文件区分原生运行验收、受控协议驱动、文件故障注入与尚未提供的渠道适配。

## 已通过的实际运行场景

| 范围 | 验收事实与本地证据 |
| --- | --- |
| DSH 0.2.2-rc.1 任务事件 | 真实 Worker 问题唤醒 App Router；已知格式由 Router 回答；未知颜色偏好留给用户；运行中查询真实写文件进度；无可选 worker_report 的正常最终答复结束任务。`artifacts/superagent-bot-development/dsh-router-attention-native/worldlinebox-bot-host-xa4JqU/receipt.json`。 |
| 双原生环境与插件 | A 配色工具、B 文本统计工具、各自独立便笺；实际工具结果与文件状态不串；从实例管理器和原生插件管理接口安装均成功；仅界面标记插件可列出但不增加模型能力。最终安全版证据 `artifacts/superagent-bot-development/private-native-plugins/worldlinebox-bot-host-x9OxVk/receipt.json`。 |
| 运行中原生变更 | Worker 仍在运行时安装、停用、恢复全局工具插件，Host PID 不变；失败安装不丢掉原目录；同一原生会话后续步骤可用更新后的全局工具。该测试在工具已返回后的模型阶段保持 turn 活跃，不声称证明任何被卸载插件自身的函数都一定继续。 |
| 预设内插件 | 原生插件修改标准 preset 内部 composition；目录绑定实际伙伴 Worker preset；正在运行和已有历史 Worker 都保留原代次并显式 `scope.pending`，新 Worker 使用新能力；原历史前缀不变，重复请求未重放工具。早期“直接销毁重组旧运行 scope”的实验已经移除，早期验收不代表最终产品策略。 |
| 实际跨版本升级 | 私有实例从真实 0.2.1-rc.5 升级到 0.2.2-rc.1；环境 ID、Home、agents、workspace、浏览器 partition 不变，插件配置、附件、技能、存储、原会话历史与效果回执保留；新 PID 中同一原 Session 继续实际工具调用，重复旧请求未重放。`artifacts/superagent-bot-development/native-private-upgrade/worldlinebox-bot-host-UTrfz4/receipt.json`。 |
| 盒子界面 | 真实 Electron＋原生 rc.5 完成共享到私有、原生安装、真实工具目录、停用消失、保活、关闭不唤醒、重新启用和启动器管理全流程；没有使用模拟 Host。`artifacts/superagent-bot-development/ui/companion-capabilities-native-evidence.json`。 |
| 注视与状态提示 | Electron WebGL 验证覆盖控件覆盖层、窗口外坐标、缩放和停用；状态提示覆盖亮色、暗色和主题背景。证据位于同目录的 gaze／executor notice JSON 与 PNG。 |

这些模型交互使用本地确定性协议服务，不调用付费模型；验证的是原生 Session、工具执行、问题事件、回执和持久性，不代表模型回答质量测试。升级测试使用实际安装程序；该场景不替代独立的发行制品完整性校验。

## 健壮性与有界性

实例管理测试覆盖同伙伴并发只建一个环境、各伙伴独立 PID 与目录、租约防回收、未知原生状态拒绝回收、问题和后台工作阻止退出、明确停止与自动重启竞争、升级失败恢复、进程中断后的快照恢复、保活恢复并发与实时启用状态复查。恢复测试使用真实文件字节与独立子进程故障注入，不能替代上表的跨版本原生验收。

能力目录测试包含 1507 个工具，逐页最多 30 项，不携带完整 schema；summary 只含数量和版本，单工具参数和技能正文按需获取。Router 通过当前宿主身份查询，不能指定另一伙伴或实例，查询期间配置变动会要求重读。人格提示词不会随插件数量增长。

任务测试覆盖已结束与暂停计时冻结、直接移除、迟到事件不复活、停止旧通知、多个待答问题精确绑定、已完成缺报告结算、旧 waiting 修复、原任务跟进、真实进度读取以及关闭伙伴后的准入与恢复。工具服务器关闭会等待已中止异步回调结束，避免关闭数据库后仍写文件或提交回执。

## 内存与生命周期

最终双 Host 的工作集分别为 435216384 和 481730560 字节，约 415／459 MiB；私有提交分别为 450646016 和 497995776 字节。测量对象是这两个空闲原生 Web Host，使用默认原生组件与演示插件，没有本地大语言模型，不包含世界线盒子或本地模型接口服务。不能据此保证任意第三方插件或十几个常驻环境的用量。

普通伙伴可以共用默认环境；私有环境按需启动，空闲通常两分钟退出，启动新环境时以三个非保活缓存 Host 为软目标回收旧空闲环境。活动或保活服务不会为达标被杀死；这不是强制内存上限。保活是明确选择，伙伴系统初始化后只恢复已启用伙伴的持久保活环境，最多两个并行准备，不启动全部伙伴。

## 原生生态边界

“安装了插件”“插件已启用”“注册了模型工具／技能”“某个旧 Worker 已经使用新预设”是不同状态。全局工具热更新遵循原生步骤边界；预设内变更不对有历史 Worker 强行重组。私有环境可用「应用待更新能力」申请空闲重连，保留原生记录；正在执行任务时不会为了刷新目录强制断开。

原生公开接口没有约束任意插件新入站的全局准入事务。空闲证明、盒子租约和已打开工作台保护盒子管理的执行；持续收件的外部渠道应启用保活。不能把一次空闲快照描述成任意第三方定时器、连接或未知插件都永远不会再产生事件。

QQ 官方插件当前源码将入站交给原生 `agent.followup`，并自行管理平台 peer 对应的原生 Session。因此安装在伙伴私有环境中可以隔离配置、账号与原生状态，但不会自动进入 App Router、VCP 和盒子的受众授权。要复用盒子同一主脑，需要单独的、带鉴权与稳定消息去重的渠道适配。此次没有连接 QQ 账号或发送平台消息。证据见 [入站源码](https://github.com/tencent-connect/dsh-qqbot/blob/main/src/transport/inbound.ts)、[会话管理源码](https://github.com/tencent-connect/dsh-qqbot/blob/main/src/session/session-manager.ts)；这是所查上游 main 的设计边界，不是对所有插件版本的兼容承诺。

独立 DSH_HOME 是配置与状态隔离，不是 OS 沙箱。插件硬编码公共目录或使用同一外部账号时，仍可能共享其自行选择的状态。插件和技能描述只作为参考数据，不扩张本轮任务授权。

## 交付核对

最终相关单元回归为 195 个文件通过、1370 项通过，14 个文件／17 项依环境门控跳过。需要真实安装版本的上述原生场景已显式单独运行，不能把默认跳过当作原生验收通过。完整 TypeScript 检查和改动范围的 ESLint 检查通过。

最终生产包通过 `postPackage` 资源门禁后，再用真实 `app.asar` 运行能力管理、全局注视、主题状态提示三项 E2E，3 项通过（5.4 分钟）。测试强制核对 `app.isPackaged` 与隔离 profile，插件管理连接实际 admitted rc.5 环境；没有重新构建 Vite 或替换产品源码。日志：`.tools/companion-ui-packaged-e2e.log`；截图与原始回执独立归档在 `artifacts/superagent-bot-development/packaged-ui-2026-11-06/`，测试所有临时 profile 及其受管进程均已清理。

相关单元回归命令：

```powershell
node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/unit/bot- tests/unit/dsh- --maxWorkers=2
```

原生插件验收先将 `WORLDLINEBOX_BOT_DSH_PROGRAM` 设为已安装 rc1 的 `program` 绝对路径，再运行 `tests/unit/bot-dsh-private-plugins-native.test.ts`；任务事件场景运行 `tests/unit/bot-dsh-router-attention-native.test.ts`。真实升级场景将前者设为 rc5、`WORLDLINEBOX_DSH_UPGRADE_PROGRAM` 设为 rc1，再运行 `tests/unit/dsh-companion-upgrade-native.test.ts`。这些测试只在临时私有环境中操作，不使用用户原有会话或平台账号。

安装包校验与远端提交以实施计划的完成记录为准。生成的截图和回执留在被 Git 忽略的 `artifacts/`；测试源、演示插件、桥接源、资源清单和文档进入仓库。语音 INT8 模型与 VAD 权重继续由 Git LFS 跟踪，词表、许可和固定摘要由普通 Git 跟踪。

Windows Installer 正式脚本已 exit 0：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows.ps1 -Action Installer -Proxy http://127.0.0.1:7897`。完整日志为 `.tools/companion-capabilities-installer.log`，`postPackage` 已核验实际包中的语音模型、原生依赖、桥接与全部示范插件；安装器压缩成功。

| 制品 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `out/make/inno/WorldlineBoxSetup.exe`，2026-11-06 19:22 | 1710054579 | `92911ea2ac27f2ecb6a9420ff4cd9753dc3cab2acfe055ddc2bf213e6b2f92fc` |
| `out/WorldlineBox-win32-x64/resources/app.asar` | 805354220 | `be65d7e202b15eae2476881a7b46dd450ac6665778be92fd0097585f15095371` |

`git lfs fsck` 通过；`git lfs push --all origin main` 已成功核对 11 个对象，包含语音、VAD、向量模型和 Live2D 源资源。安装产物留在本地 `out/`，固定来源、权重、运行源码和测试进入版本控制。

实现提交 `319720d536b81fd635b451f4cc1c087b97ecb137` 已推送至 `https://github.com/whoiswennie/WorldlineBox.git` 的 `main`；远端分支列表仅有 `main`，并已核对实现提交与本地一致。本完成记录作为随后单独的文档提交保存。
