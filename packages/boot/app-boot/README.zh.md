# @deepseek-ai/dsh-app-boot

[English](README.md) | 中文

共享的 Cordis Loader 引导、Profile Bundle 组合、分层环境加载与遇错即失败的配置保护。

## 模型体验

通过所选 Profile 加载的插件树间接影响模型。

#### KV Cache 影响

引导过程本身不增加请求 token；缓存复用取决于最终插件树贡献的 Prompt 与工具。

## 已知限制与延后工作

- **进程内引导**——每次调用只解析并启动一棵 Loader tree；分布式配置与跨进程协调仍由应用负责。
