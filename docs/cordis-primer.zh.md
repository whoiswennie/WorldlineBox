# Cordis 插件模型

[English](cordis-primer.md) | 中文

## 五个基本概念

### Context 是服务与生命周期视图

插件通过 `ctx.<key>` 使用已声明的服务。Context 还携带当前 Fiber、scope 和 effect 所有权，因此不能把任意 Context 长期保存到脱离生命周期的全局变量中。

### Service 定义稳定能力

Service 子类在构造时声明 Context key。抽象 Service 只定义能力；具体 Provider 继承或实现它。消费者导入定义包，不导入本地、远程或桌面 Provider。

### inject 表达依赖拓扑

<a id="loader-configuration"></a>

`inject` 是插件激活条件，不是文档注释。必需服务缺失时插件保持等待；可选服务通过 `ctx.get(key)` 在使用点读取。不得用加载顺序或延时器替代依赖声明。

### Events 表达可组合扩展点

<a id="dispatch-modes"></a>

<a id="cordis-waterfall-semantics"></a>

- `emit`：同步观察，不返回结果。
- `waterfall`：中间件链；协作监听器必须调用 `next()`。
- `parallel`：等待全部监听器并行完成。
- `serial`：按顺序等待，用于确定性的停止或提交过程。

事件名和载荷通过 TypeScript declaration merging 声明。持久事实使用 Session Event；实时协调使用 Agent 或能力事件。

### Effect 让贡献可撤销

文件监听、路由、工具、Prompt section、Provider、Slot 和事件监听都必须绑定 Fiber。可使用：

```ts
declare const ctx: {
  effect(setup: () => () => void, label: string): void
  on(name: string, listener: () => void): void
}
declare const registry: { register(value: unknown): () => void }
declare const value: unknown
declare const listener: () => void

ctx.effect(() => registry.register(value), 'package: contribution')
ctx.on('domain/event', listener)
```

如果 registry 内部使用调用方 Context 创建 effect，可直接调用其 `register()`；该生命周期语义必须由 registry 契约和卸载测试证明。

## 两种插件形式

函数插件导出 `name`、`inject`、`Config`、`apply`，不提供 default export。Service 插件 default-export Service 类。混合两种形式会让 Loader 无法可靠区分插件元数据和实现。

## Fiber 状态

Fiber 经历等待依赖、加载、激活、卸载和释放。初始化失败必须回滚已创建的 effect；卸载必须等待异步 disposer；被取消的操作不能在 Fiber 释放后发布状态。

Worldline 将 `FiberState` 保留为运行时 enum，以支持独立构建的 Loader、桌面和插件跨包检查状态。当前 vendor 约定记录在 [`vendor/README.md`](../vendor/README.md) 中。

## Scope 与 Agent Preset

进程级服务存在于 Host Context。会话或 Agent 特有的工具、Prompt 和 Provider 贡献安装到 Agent scope。私有编排链从 initiator scope 恢复 Agent，再显式捕获其 Session；不得依赖隐式全局“当前会话”。
