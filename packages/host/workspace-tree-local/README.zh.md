# @deepseek-ai/dsh-host-workspace-tree-local

[English](README.md) | 中文

`host-workspace-tree` 的本地文件系统 Provider。它通过 realpath 规范化根目录，拒绝路径穿越和逃逸 symlink，对列表、搜索和文本预览设定边界，并通过 Cordis 生命周期持有防抖 Chokidar watcher。图片、音频和视频在预览中只返回元数据；完整读取或闭区间 Range 读取使用有背压的文件流，因此播放容量受磁盘约束，而不是受 RPC 内存约束。外部导入会流经隐藏的暂存文件，再以不覆盖现有条目的方式原子链接到目标位置；`maxImportBytes` 默认为 128 GiB。

变更操作会验证现有来源和注册根目录内的新目标。搜索忽略依赖与生成输出目录，绝不跟随 symlink，并在达到配置的扫描或结果上限时报告截断。

## 模型体验

### 本地工作区投影

#### 模型看到什么

什么也看不到：文件系统条目与预览内容通过 `workspaceTree` 返回给产品 Client，不会注入 Agent 上下文。

#### Token 影响

列表、搜索、预览和变更不会增加模型请求 token。

#### KV Cache 影响

文件系统变化和 watcher 通知不会改变模型前缀，除非另一个包显式读取并提交变化内容。

## 已知限制与暂缓事项

- **有界文件名搜索**：搜索只匹配名称和相对路径，不索引文件内容，并可能在达到配置的扫描或结果上限后截断。
- **本地 Provider**：远程工作区与虚拟文件系统需要另一种 workspace-tree 服务实现。
