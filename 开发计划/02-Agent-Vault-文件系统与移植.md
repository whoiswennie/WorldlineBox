# Agent Vault 文件系统与移植

## 标准目录

```text
agents/<agent-id>/
├─ manifest.yml
├─ AGENTS.md
├─ self/
├─ memory/
│  ├─ short/
│  ├─ medium/
│  └─ long/
├─ procedures/
│  ├─ cards/
│  ├─ methods/
│  ├─ experiences/
│  └─ tests/
├─ resources/
│  ├─ by-date/
│  ├─ objects/
│  ├─ records/
│  └─ collections/
├─ maps/
├─ skills/
├─ queue/
├─ tests/
├─ history/
└─ .system/
   ├─ indexes/
   ├─ cache/
   ├─ dirty/
   ├─ locks/
   └─ runtime/
```

`.system/` 之外的内容构成可移植语义真源。导出默认排除缓存和临时状态，但包含索引可重建所需的所有地图、记录、资源和测试。

## `manifest.yml`

清单至少包含：

```yaml
format: worldline-agent-vault
format_version: 1
agent:
  id: yachiyo-runami
  name: 月见八千代
entrypoints:
  identity: self/identity.md
  appearance: self/appearance.md
  policy: policy.yml
requirements:
  capabilities:
    - agent-vault
integrity:
  algorithm: sha256
  files_manifest: checksums.yml
```

清单不得保存本机数据根目录、账号凭据、临时下载 URL 或工具秘密。

## 虚拟路径

工具和文档只使用以下命名空间：

| URI | 含义 |
| --- | --- |
| `vault://` | 当前 Agent 的 Vault 根 |
| `shared://` | 授权公共知识或共享资源 |
| `agent://<id>/public/` | 其他实体公开资料 |
| `resource://sha256/<hash>` | 内容寻址二进制对象 |
| `temp://session/` | 当前会话临时目录，不导出 |

解析器必须拒绝绝对路径、盘符、UNC 路径、越界的 `..`、非法保留名和逃逸 Vault 的符号链接。Windows 大小写、Unicode NFKC 和路径分隔符必须归一化，但 UI 保留原始显示名称。

## Wiki 链接

支持：

```markdown
[[memory/long/music/朧月夜]]
[[memory/long/music/朧月夜#发行信息]]
[[procedure:comic-design|连环漫画设计]]
[[resource:sha256-abc123|原始 PDF]]
[[entity:user-123|用户]]
[[tag:二次元]]
```

文档移动由 Vault 服务完成：移动事务更新 ID 路径映射和受管反向链接，旧路径产生有期限的重定向记录。Agent 不通过 Bash 批量移动文件。

## VFS 服务与工具

Host 提供的基础能力至少包括：

```text
vault.info
vault.list
vault.stat
vault.read
vault.read_section
vault.create
vault.update
vault.move
vault.link
vault.backlinks
vault.diff
vault.history
vault.resolve_path
vault.reconcile
```

写操作必须携带目标域、预期 revision、调用者 Agent、操作原因和授权上下文。服务负责原子写入、事件记录、脏索引登记和历史版本，不允许每个上层工具各自实现一套文件事务。

## 外部工具真实路径租约

只有外部工具确实需要本机路径时才调用：

```text
vault.resolve_path(uri, mode="read" | "write")
```

读租约返回受控真实路径；写租约还要经过冻结和权限检查，并返回 `lease_id`。外部工具结束后调用：

```text
vault.reconcile(lease_id)
```

`reconcile` 重新计算哈希和 revision，触发索引更新并记录外部修改。文件监听器和启动时差异校验负责兜底。Skill 明确禁止把返回的真实路径写入持久文档。

## 资源文件

原始二进制采用内容寻址存储，日期目录保存导入事件和人类可读清单：

```text
resources/
├─ by-date/2026/08/29/import-001.yml
├─ objects/sha256/ab/abcdef...
└─ records/asset-uuid.yml
```

规则：

- 相同哈希不重复保存对象，但每次导入都可以记录事件。
- 同日同名、内容不同在 UI 上可显示为替换，底层创建新 revision 并保留旧对象。
- 不同日期的同名文件各自保留导入记录，并可通过 lineage 关联为同一文件系列。
- 文档来源引用 `resource://`，不引用下载目录或桌面绝对路径。
- 大文件采用流式复制和哈希，不进入进程堆；媒体读取支持区间请求。

## 导出

提供两种模式：

- 完整迁移包：包含身份、状态、全部记忆、关系、能力、资源、历史和角色专属 Skill，可选加密，不包含账号凭据。
- 可分享角色包：移除用户私密关系、私人来源、对话隐私和临时状态，保留身份、人设、公共能力、资源与可分享知识。

导出在临时目录建立一致性快照，生成文件清单和 SHA-256，完成后再原子发布压缩包。导出过程中原 Vault 可以继续读取；写入要么进入快照前 revision，要么留给下一次导出，不能形成一半新一半旧的包。

## 导入

导入必须先进入隔离目录：

1. 校验格式、版本、文件数量、总大小和压缩比。
2. 拒绝 Zip Slip、绝对路径、符号链接逃逸、设备文件和非法文件名。
3. 校验 SHA-256、必需入口和资源对象。
4. 检查所需插件、工具和能力依赖。
5. 展示身份、资源数量、记忆规模、隐私内容和缺失依赖预览。
6. 处理 ID 冲突：替换、复制为新伙伴或受管合并。
7. 安装到新目录，重建索引和缩略图。
8. 运行结构、链接、召回和能力可用性测试。
9. 所有检查通过后才将伙伴标记为可用。

导入后内部 `vault://` 和相对链接不变。复制为新伙伴只修改实例 ID 和必须保持唯一的外部身份，不批量写入本机绝对路径。

## 能力依赖

Vault 可以迁移方法、经验和角色专属 Skill，但不能伪造目标机器不存在的执行工具。导入器把能力标记为：

- 可用
- 部分可用
- 缺少依赖
- 需要重新测试

伙伴必须表述为“保存了该方法但当前设备缺少执行能力”，不能因为能力卡存在就宣称实际可执行。
