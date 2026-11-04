# 新伙伴物理世界

本页描述 2026 年 11 月 2 日重构后的窄世界 domain。旧独立窗口、world observer IPC、CompanionStore 和日常自主 routine 已退役。完整运行说明见 [Super Agent 运行说明](superagent-bot-runtime-guide.md)。

## 状态与规则

`src/main/companion-bot/world.ts` 保存物理快照与事件；`src/shared/world-physics.ts` 提取真实小屋／花园的几何、可走判定、A* 路径与 2.4 tile/s 行走规则。DTO 与命令在 `src/shared/companion-bot-world.ts`，不引入旧伙伴巨型 schema。

- 每位伙伴有私人小屋，并可前往公共花园；不能使用聊天文字进入其他伙伴私人小屋。
- move 沿可通行路径行走；travel 先抵达出入口，再转入目标场景，不立即跨场景瞬移。
- interact 先抵达家具锚点，并通过预约／占用保护资源；stand 释放占用。
- 观察提供自己的私屋、公共场景及获准的同场人物。当前没有复活旧的天气／关系／视线遮挡／作息模拟。
- 状态及 effect receipt 原子保存，effectId 幂等、revision 防旧命令覆盖；抵达和动作事件通过持久 outbox 投递。

世界事件只给实际同场观察者与自己。每位观察者有私有 world lane；仅使用 recipientIds 而把原文放进公共群 transcript 仍可能泄露，因此不能代替私有来源会话。

物理工作姿态不证明 DSH 已经执行。现实文件、命令与研究任务需要单独的可信任务工具与真实回执。

## 2D 与 Three.js

`BotWorldScene.tsx` 提供位置图、家具操作和旅行按钮；`BotWorld3D.tsx` / `world-3d.ts` 只消费新 BotWorldSnapshot，并通过同一 world.act API 提交动作，没有自己的旧 Store 或世界控制器。

真实小屋与花园 builder 保留在 `src/renderer/companions/world/{world-room-model,world-park-model}.ts`，它们已改用新轻量 DTO。帧采样、动作图组和校准资源继续由现有纯美术模块提供。新建伙伴显示本人姓名标记；匹配既有美术 ID 时使用对应 sprite，不能借用另一人物外观。

渲染最多 30fps，隐藏或停用时暂停；卸载释放 geometry、material、texture、事件监听和 WebGL context。初始化或图形上下文失败时返回可操作的位置图。旧的独立 World/Window 生命周期和旧 IPC 不挂载。

## 验证边界

- `tests/unit/bot-world.test.ts`：真实 SQLite、移动／出入口／占用、受众边界、重启、幂等与 revision。
- `tests/unit/bot-world-ui.test.tsx`：新 API、真实坐标、SVG letterbox 点击与迟到观察隔离。
- `tests/unit/bot-world-3d-fallback.test.tsx`：WebGL 不可用和运行中丢失上下文后的恢复。
- `tests/e2e/companion-bot-world.test.ts`：实际 Electron/IPC/Three，移动到指定坐标并进入花园；不调用外部模型。

稳定截图是 [小屋](../../artifacts/bot-refactor-2026-11-02/ui/world-3d.png)和[花园](../../artifacts/bot-refactor-2026-11-02/ui/world-3d-park.png)，[图形与位置证据](../../artifacts/bot-refactor-2026-11-02/ui/world-3d-evidence.json)记录真实 WebGL2、draw calls 和三角数。本机为 Microsoft Basic Render Driver 软件渲染，这不是硬件帧率或多窗口性能证明，也不能替代主脑自然语言决策验收。

美术资源的原始制作记录见 [动作图组](companion-world-art.md)及[帧校准](companion-world-art-calibration.md)。这些历史美术记录不代表旧世界模拟仍在运行。
