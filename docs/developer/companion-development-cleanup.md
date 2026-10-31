# 伙伴开发版清空与重新建立

本工具落实[认知重构规范](companion-cognition-refactor-standard-2026-10-28.md)的 R15。它面向明确选中的开发版伙伴库，不是旧伙伴迁移器。应用必须停止该库的写入后才能执行。本文中的路径是占位示例。

## 1 先生成可审阅清单

```powershell
node scripts/companion-managed-cleanup.mjs plan --library C:\absolute\selected-library --library-id ACTUAL_LIBRARY_ID --out C:\absolute\cleanup-plan.json
```

此步不打开原 SQLite 连接。工具检查实际库身份、根路径、链接、WAL/SHM/日志占用后，通过临时副本读取表结构和记录数量。清单固定文件路径、归属、字节 hash、大小及设备信息。执行前必须审阅 `owners`、`tables`、`files`、`preservedPaths` 和 `retainedHostData`。有未知 SQL 表时拒绝生成可执行清单；未知根目录文件保留并列出，不按目录名把它们认作记忆。

## 2 用同一清单执行

```powershell
node scripts/companion-managed-cleanup.mjs execute --plan C:\absolute\cleanup-plan.json --plan-hash REVIEWED_PLAN_HASH
```

`planHash` 只是固定执行范围，不代表另一次用户授权。工具不接受其他隐含删除开关。它在排他事务内再次核对原库，并只删除清单中的受管文件；不递归扫描删除 DSH 目录。库外模型连接、密钥保持不动。已移除的额度制度不会恢复；旧账本内的额度记录和受管根目录精确文件名 `模型资源预算.json` 列入清单，其同名备份、其他普通文件和共享 DSH 文件不因相似名称而删除。

清理最后移除原 `messages.sqlite`，结果返回 `new_database_required: true`。新应用必须从空文件建立新协议 schema，不能给旧 DDL 增加 marker 后继续运行。精确 sidecar 存在时工具停止，要求先停止实际写入者；它不会擅自删掉可能尚未提交的 WAL。

## 3 人类资料保留

仅人类 `user` 的公开资料与其实际头像、设定图附件写入固定的 `development-cleanup/retained-host-data.json`。清单不包含 SQL、旧伙伴身份、历史、权限、工具结果或模型密钥。导入只读取这份白名单清单和固定附件路径，重新核对大小、hash、图片格式、库身份与已完成的清理凭据，不扫描旧库。

新数据库建立 schema 并生成默认玩家资料后、创建任何伙伴之前，调用 `importCompanionRetainedHostData`。导入通过单次 receipt 保证幂等；已有新玩家编辑、伙伴记录、错误归属或变动附件均阻止覆盖。再次添加伙伴始终生成新 ID。

## 4 中断与边界

`development-cleanup/<planHash>.json` 保存新清理协议的阶段。中断后用同一命令续做，不恢复已删除身份。完成凭据存在时重复执行不会删除新建立的数据库。计划之后的字节、路径、归属或记录变化均应重新核验。

检查预算初值为单文件及数据库 512 MiB、所有计划文件总计 8 GiB、最多 50,000 个文件、目录深度最多 20。达到上限会停止。它们是工程初值，不是心理学或学习效果结论。

验证覆盖见 [companion-development-cleanup.test.ts](../../tests/worker/companion-development-cleanup.test.ts)：只读清单、hash/库身份/占用拒绝、库外资源保留、新库人类资料导入，以及提交后中断续做。测试只使用临时目录。
