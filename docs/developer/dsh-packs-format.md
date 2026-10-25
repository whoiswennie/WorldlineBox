# DSH 整合包与原生备份

`packs.ts` 管理可分享的配置整合包；`archive.ts` 实现 ZIP 封存、流式读取、路径检查与文件摘要。个人完整数据使用 `InstanceService` 的原生备份，二者的内容边界不同。

## 整合包

原生 Web 整合包只采用 `worldlinebox-dshpack-v2`，固定官方源码 SHA-256、npm SHA-512 SRI、依赖图摘要、Node/npm 版本、Node 二进制和实际 payload 摘要。`runtime-lock/package-lock.json` 用于在缺失制品时重放官方安装并核对完整身份，不能只凭同名版本或 latest 替代。不再接受旧运行适配器及 v1 整合包。

可分享内容包括：

| 路径 | 内容 |
| --- | --- |
| `home/profiles/**` | 原生 manifest、patch、workspace 与依赖锁 |
| `home/cordis.patch.yml` | 原生 Home 覆盖配置 |
| `home/skills/**`、`agents/skills/**` | 原生技能 |
| `home/skills-disabled/**` | 用户停用的技能及来源记录 |
| `runtime-lock/package-lock.json` | Node 运行制品的依赖锁 |

排除会话、附件、storage、凭据、环境文件、匿名身份、浏览器数据、工作区、运行缓存、`node_modules` 和运行事务锁。启动器自供的 `@worldlinebox/dsh-bridge` 是本机 file 依赖，在暂存副本的 manifest 和 pnpm lock 中移除，恢复时由当前应用重新安装；来源配置不改动。第三方插件的原生声明与依赖锁保留，不重写 pnpm store 路径或复制旧 store。

安装创建新实例并调用原生包管理器恢复依赖，可能需要网络和插件生命周期脚本。账号、模型、会话与技能由新实例原生配置管理，没有共享存档合并步骤。普通用户的其他本地 file/link/workspace 插件依赖不可移植，导出应明确拒绝，改用 npm/GitHub 版本或先整理成可移植插件。

## 清单、完整性与分发

归档包含 `manifest.json` 与 `data/**`。文件清单采用相对于 data 的路径、逐文件 SHA-256、大小、总数、总字节与清单指纹。验证拒绝额外/缺失/修改文件、绝对路径、目录逃逸、Windows 设备名与 ADS、大小写或 Unicode 碰撞、链接和特殊文件。文件数、单文件与总大小均有限制。失败暂存目录不登记为可用包。

公开分发生成归档、分享清单与 sha256 文件。外部分享清单固定归档大小、摘要、内部文件清单和运行锁；下载后核对内外清单再导入。GitHub 发布默认创建草稿，Token 不持久化。只有用户明确选择才公开发布。

可移植配置审查拒绝明显秘密、绝对用户路径和本地依赖。摘要保证完整性，不认证作者；插件与技能仍按原生 DSH 权限执行。分享前应检查自定义配置，个人会话与凭据使用私人备份。

## 快照与私人备份

格式为 `worldlinebox-native-dsh-backup-v1`，保存停止实例的 `data/home`、`data/agents`、`data/workspace`，清单绑定精确运行制品与完整内容摘要。只排除原生运行缓存、依赖目录与锁；普通工作区里的 logs/cache 文件夹属于用户数据，必须保留。

快照恢复必须已安装精确运行制品，验证清单后建立新实例，复制原生目录并由原生包管理器恢复依赖。完整 ZIP 备份的外层格式是 `worldlinebox-native-dshbackup-v1`，额外封存精确运行制品；缺失版本时先校验并导入，再恢复原生目录。它们不会寻找、迁移或合并旧 shared 数据，不会改写会话 JSONL，也不把凭据导入另一个全局存储。浏览器 partition 为新实例独立建立。

`tests/unit/dsh-pack.test.ts` 覆盖封存、篡改、路径检查、运行身份、原生配置与技能、凭据排除和桥接依赖排除；`tests/unit/dsh-instance.test.ts` 覆盖原生备份恢复及普通工作区数据保留。真实生态和重启验证见 [验收记录](dsh-native-web-acceptance-2026-10-25.md)。
