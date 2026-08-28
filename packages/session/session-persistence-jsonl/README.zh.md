# @deepseek-ai/dsh-session-persistence-jsonl

[English](README.md) | 中文

持久追加式 Session Log 的 Cordis Provider。每个物化 Session 存储为带校验和的 JSONL/Zstandard Artifact，并通过 `@deepseek-ai/dsh-session-persistence` 协调。

Provider 拥有物理恢复、连续序号检查、批量写入、Flush Barrier、Preparation 复用、取消与静默释放。Consumer 只依赖持久化 Service Definition。

## 模型体验

### 持久 Session 存储

#### 模型看到什么

没有直接内容：带校验和的 `JSONL` Record 重建 Session 事实，之后由请求组装 Consumer 选择其中内容。

#### Token 影响

持久化不增加 token；重建后的 Event 与其原始模型可见 Projection 具有相同的 token 影响。

#### KV Cache 影响

保存、恢复或紧凑存储 Event 不改变其顺序或模型前缀，因此不会独立使缓存复用失效。

## 已知限制与延后工作

- **本地 Artifact 后端**——每个物化 Session 存储于本地 JSONL/Zstandard Artifact；共享网络持久化和多 Writer 协调需要其他 Provider。
- **原生 Codec 依赖**——压缩 Artifact 依赖当前平台受支持的 Zstandard Binding。
