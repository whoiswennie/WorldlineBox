# @deepseek-ai/dsh-tool-workspace

[English](README.md) | 中文

可选 Cordis 插件，贡献限制在工作区内的 `read`、`write`、`edit`、`glob`、`grep` 和 `pwsh` 工具。最小 Agent Loop 不导入该包；应用 Profile 需要显式启用它。

## 模型体验

### 工作区工具

#### 模型看到什么

挂载该可选插件后，模型会收到 `read`、`write`、`edit`、`glob`、`grep` 和 `pwsh` 工具定义，以及受限的 JSON 结果。

#### Token 影响

工具定义增加固定请求前缀；每次调用追加参数和结果，结果受配置的读取、输出或搜索上限约束。

#### KV Cache 影响

只要配置与包代码不变，工具定义前缀就保持稳定；工具调用追加在该前缀之后，Provider 支持前缀缓存时可以复用它。

## 已知限制与暂缓事项

- **全新 PowerShell 进程**：每次 `pwsh` 调用都会启动新进程，因此 shell 状态与环境变更不会跨调用保留。
- **外部命令限制**：基于路径的工具会强制工作区包含性，但操作系统 sandbox 与批准策略仍须约束 `pwsh` 执行的命令。
- **有界进程内搜索**：glob 和 grep 使用包内遍历与正则实现，不遵循原生 ignore 文件或 ripgrep 语义。
