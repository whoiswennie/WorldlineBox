# 测试与质量门禁

[English](testing-and-quality.md) | 中文

## 证据层级

| 层级 | 证明内容 |
| --- | --- |
| 单元测试 | 局部算法、错误语义和边界值 |
| 生命周期测试 | Fiber 单独卸载后贡献消失、运行中操作终止 |
| Cordis 真实组合测试 | Loader、inject、Profile、Provider 选择和启动失败 |
| Client 测试 | Slot/Locale/Remote/Session scope 的浏览器行为 |
| Web E2E | 用户旅程和 Host/Client 联动 |
| Snapshot | 模型可见 Prompt、工具、日志和最终 transcript |
| Built smoke | 构建产物、exports、裸 Node/Electron 启动 |

只手工 `ctx.plugin()` 的测试不能证明产品 Bundle 真正加载了功能。用户可见或模型可见改动必须至少有一个真实组合或 Snapshot 证据。

## 必须执行的门禁

- 运行时架构与兼容边界；
- 运行时品牌与兼容例外审计；
- 源码/产物分层；
- Host/Client TypeScript aggregate；
- Runtime、Client、CLI、Desktop 测试；
- Snapshot 与 E2E 产品组合测试；
- Cordis 配置和 package invariant 完整性；
- Client bundle purity；
- 构建产物和运行时闭包 smoke。

## 回归要求

每个缺陷都要覆盖最初失效的入口。生命周期缺陷测试必须卸载准确的插件 Fiber，而不是只释放根 Context。安全策略必须从最终 executor 证明拒绝，不能只测试 UI 隐藏或 schema 缺字段。

## 当前聚合命令

```powershell
pnpm run check:architecture
pnpm run build
pnpm run verify:built-package-invariants
pnpm run publint
pnpm run test:runtime
pnpm run test:client
pnpm run test:scripts
pnpm run test:cli
pnpm run test:desktop
pnpm run test:python
pnpm run test:snapshot
pnpm run test:e2e
pnpm run docs:build
```

Runtime 限制为 4 个 worker，工程脚本套件串行执行。这里的并发限制是测试隔离契约：前者包含真实文件监视器、子进程和外部产品夹具，后者会创建 Git 仓库、worktree、hook 与合并驱动。提高并发前必须证明不会造成事件丢失、超时或临时仓库清理越界。

发布验证分两层：工作区可以保留供仓库内测试使用的 `./src/*` 导出；npm 发布视图必须移除这些导出，只包含 `files` 声明的编译产物。`publint` 检查的正是发布视图，`verify:built-package-invariants` 则用裸 Node 与真实 Loader 加载 227 个包的伴生入口。

Snapshot 的 `record`/`refresh` 通过 `scripts/run-snapshot-mode.mjs` 注入环境，因此在 PowerShell、cmd 和 POSIX shell 上使用同一命令。Windows 产品组合以 pwsh 证明真实 shell 路径；只声明 Bash 语义的示例测试在 Windows 明确跳过，由包级 Bash 契约和非 Windows CI 覆盖，不通过不可用的 WSL 安装制造伪成功。
