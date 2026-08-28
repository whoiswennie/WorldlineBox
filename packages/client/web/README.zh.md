# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

Web 外壳内核：`new AppWebEntry(el, seams?).run()` 通过两阶段启动（web2）挂载整个客户端。第一阶段（模块侧）：构建客户端模块系统（`@deepseek-ai/dsh-client-modules`），以主机推送的配置项图（`window.__WORLDLINE_BOOT__`）为基础，并行预取 `immediately` 层级；执行组合包只会注册 factory。第二阶段（插件侧）：挂载仓库内置的 Cordis Loader，并通过其 `internal` 约定注入模块系统；为每一行图数据创建一个 loader 配置项，另创建外壳自身的 app-shell 组装配置项（tree.import 会物化各模块）；以 settle 作为 AppRoot 的门禁（loader 完全停稳 + 每个配置项 fiber 都为 ACTIVE → 一次切换显示完整 UI）。组合完全由主机图决定：花名册和 immediately 层级都位于负责组合的应用中；外壳不作任何组合决策。

启动页只使用原生 DOM 与本地 CSS，因此客户端 bundle 或插件激活失败时仍能显示。其回退字体和颜色与加载期间到达的主题 token 一致。fiber 更新会保留同一个 spinner 节点，并在 entry 首次进入 active 时增长其 CSS 圆弧；hydrate 会继续保留该节点及其动画相位，直到应用提交。React 挂载、slot 渲染、应用组装和浏览器标题投影位于 [`ui-renderer`](../ui-renderer/README.md)。Modules bundle 会缓存自身已物化导出，并在其普通图 entry 激活时提供闭包中的系统；Cordis service 等待使图 row 创建顺序不依赖该激活时点。

`PLATFORM_MODULES`（src/platform.ts）是外壳播种共享模块的唯一事实来源。它与 `PRELOADED_CLIENT_EXTERNALS` 一起定义全部动态 bundle 的隐式 external 基座；`dsh.client.external` 只添加基座之外的精确请求。

可选的覆盖参数 `seams` 会为外部 `<script>` 执行无法到达页面上下文的环境转发模块系统的 `loadBundle` 传输覆盖（`BootSeams`）；普通浏览器调用方省略此参数。

## 模型体验

无。入口外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **应用会等待完整名册**：只要一个 entry 失败，不依赖框架的启动页就会保留并逐项报告；不支持部分 UI 可用。
