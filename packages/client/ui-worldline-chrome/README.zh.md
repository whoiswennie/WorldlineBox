# @deepseek-ai/dsh-client-ui-worldline-chrome

[English](README.md) | 中文

世界线自有的桌面框架，包含工作区、终端会话、运行时日志、工具链状态和产品状态栏。它填充稳定 UI Slot，并把每项特权操作委托给经过认证的 Host Remote。

工作区浏览器与编辑器共享 workspace-tree 能力，终端和运行时日志工作台使用 Host API carrier。该包只包含呈现与 Client 协调；它不会直接读取文件系统或启动进程。

## 模型体验

### 产品工作台

#### 模型看到什么

什么也看不到：工作区预览、`TerminalRawReadResult` 值和运行时日志记录留在 Client 工作台中，除非用户另行提交其内容。

#### Token 影响

打开或操作产品工作台不会增加模型请求 token。

#### KV Cache 影响

框架状态与 Host 轮询独立于模型前缀，不会使 cache 复用失效。

## 已知限制与暂缓事项

- **由 Host 支撑的席位**：工作区、终端、浏览器和运行时日志控件需要对应的已认证 Host 服务；该包不提供纯浏览器回退实现。
