# 伙伴实例与 Agent 流程验收（2026-10-27）

## 范围与结果

本次验收覆盖当前实例资料、话题上下文、联系人分组与删除、正文和能力步骤渲染、DSH 委托、中断恢复、运行中引导、同角色并发与聊天历史分页。没有操控用户桌面或运行浏览器 UI 自动化。

独立主脑服务回归 **152 项全部通过**。使用真实服务和 SQLite、受控模型与原生执行回执验证两项耗时网页委托及群聊并行、取消隔离、DSH 启动交界输入、推理中输入、最终发布前输入、重复停止及重复重试。该结果验证宿主流程和接口协作，不是在线模型质量或真实 DSH 网页作品的验收。

最后一次全量命令：

```powershell
$env:WORLDLINEBOX_RESET_PRESSURE_COUNT='1000'
node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts --reporter=dot --reporter=json --outputFile.json=.tools/test-output/unified-final-regression.json
```

全量结果：1,335 个测试文件；10,881 项通过、44 项失败、117 项跳过，耗时 1,310 秒。**不能称为全量通过。** 重置批处理本次使用 1,000 条消息和 1,000 篇记忆；没有将用例名称中的十万条当作本次实际压力规模。另有十万文档分页、十万资产搜索、三千真实文件增量扫描与两万资产导入导出检查实际通过。

44 项失败的归因：

- 38 项在修改前提交 `43df480` 的临时独立检出中也能复现，涉及旧世界时钟测试、资产封面、网络/下载/截图设置表单和相似搜索；本次没有恢复已停用的虚拟时间模式来迎合旧断言。
- 4 项记忆用例在全量负载下超过异步断言等待时间；以 `same-source summaries|stale SQL contribution|one hundred tags` 单独复核，5 项全部通过。
- Windows Job 子进程存活断言及语义索引临时目录清理各失败一次；两个完整测试文件单独复核，10 项全部通过。没有以单次复核结果宣称它们不会再发生。

基线复现使用普通临时 Git worktree 和依赖目录联接，完成后已移除；没有改动用户的资产库内容。

## 专项证据

| 检查 | 结果 |
| --- | --- |
| 主脑服务完整回归 | 152/152 通过 |
| 世界社交、话题焦点与虚构记忆边界 | 83/83 通过 |
| 日志、游戏来源、消息双向分页与手动停止 | 68/68 通过 |
| 重置与批处理恢复 | 12/12 通过；压力规模 1,000 + 1,000 |
| 计时、组件、输入状态等夹具回归 | 75/75 通过 |
| TypeScript 主应用与扩展 | 通过 |
| ESLint | 0 错误，7 个已有 Hook 依赖警告 |

聊天窗口使用万条合成历史验证首次最新 50 条、用户向上滚动后再加载、双向翻页无重复、切换页面回到最新区域及有限挂载窗口（上限 200 条）。计时专项验证停止一小时不计入耗时、排队不增长、异常退出按最后持久进度冻结、恢复后仅继续累计运行区间。恢复后的系统错误提示不再重复出现在正文中。

## 本地原始记录

原始 JSON 和日志位于忽略目录 `.tools/test-output/`，包括 `unified-final-regression.json`、`baseline-regression.json`、`service-verified.json`、`world-final.json`、`reset-final.json`、`final-fixtures-rerun.json`、`timing-fixture-regression.json`、`memory-pressure-rerun.log` 和 `system-rerun.json`。这些临时运行产物不提交仓库。

## 打包方式

使用根目录 `03-Build-Installer.bat` 所调用的同一脚本，避免交互暂停：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows.ps1 -Action Installer
```

该脚本依次执行类型检查、Electron Forge 打包及 Inno Setup 安装包生成；安装包目标为 `out/make/inno/WorldlineBoxSetup.exe`。安装程序不自动启动，包内资源与原生模块通过仓库验证脚本核对。
