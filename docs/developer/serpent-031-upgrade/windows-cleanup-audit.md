# Windows 更新清理的原生生命周期修复

## 实际失败与定位

首轮真实更新交接 E2E 通过归档下载、SHA-256、解压、交接与应用退出，但临时安装器没有消失，测试正确失败并保留现场。失败目录 `C:/Users/hp/AppData/Local/Temp/worldlinebox-update-handoff-e2e-MeIYsk` 未由本次诊断删除或代为清理。

同一系统 PowerShell 脚本在普通子进程中可清理；加上生产环境原有的 libuv `detached:true` 后，PowerShell 返回 0，却未执行清理，连最小写 marker 脚本也没有执行。移除这个标志但让父 Node 立即退出，普通子进程又不能完成任务。因此，单纯删掉标志或只断言 `spawn` 成功都不足以证明清理有效。此前未覆盖 detached 及父进程退出的原生单元测试漏掉了该组合。

诊断证据分别保存在 `artifacts/serpent-031-cleanup-modes-probe.json`、`serpent-031-cleanup-argument-probe.json` 和 `serpent-031-cleanup-parent-lifetime-probe.json`。这些都是新建的自有 inert 临时夹具，未执行安装器。

## 最终实现

`src/main/windows-installer-cleanup.ts` 返回系统 PowerShell 的短启动脚本：由 Main 以 `detached:false`、`windowsHide:true`、`stdio:ignore` 启动，脚本用 `Start-Process -WindowStyle Hidden -PassThru` 创建系统 PowerShell 清理进程，然后退出。Main 必须等待启动脚本 exit 0 后再结束应用，等待上限 30 秒；失败记录诊断，生产安装器已启动后仍继续交接。

长期存在的进程全部使用 SystemRoot 中的原生 PowerShell，不使用安装目录中的 WorldlineBox/Electron 或 Node 进程，因此不会以监督进程占用应用可执行文件、反过来阻止 Inno 覆盖升级。临时 Node 监督原型虽能存活，但因这个安装文件锁风险未被采用。

实际清理脚本继续校验 temp 直接子目录、随机名称、精确安装器文件名和 ReparsePoint；只删除指定安装器及随后为空的目录，没有递归删除或目录扫描放宽。既有安装器进程等待和有界删除重试保留。启动失败和重试超时仍写本地 `app-update.cleanup` 诊断。

## 当前证据

- `artifacts/serpent-031-cleanup-native-start-probe.json`：父 Node 已返回 0 时安装器仍存在，此后系统 PowerShell 实际删除该文件和空目录，证明进程不是依赖父应用存活的空交接。
- `artifacts/serpent-031-cleanup-native-launch-unit.log`：Node 24 宿主下 9 项测试通过。
- `artifacts/serpent-031-cleanup-native-launch-electron-node-unit.log`：Electron Node 宿主下同 9 项测试通过，未启动应用 GUI。
- 测试覆盖未提供 PID、提供 E2E 的正 PID `730241`、严格路径拒绝，以及真实父启动进程退出后的存活。最后一项使用夹具自有 sentinel 暂停清理；父进程退出后先断言安装器还在，再释放 sentinel，只有原生 helper 删除文件/目录后才通过。
- `artifacts/serpent-031-cleanup-native-launch-lint.log`：相关源文件、单元测试与更新交接 E2E 的 ESLint 通过。
- `tests/e2e/app-update-handoff.test.ts` 已按原生短启动模型适配，保留原有真实删除断言和失败现场。最终 GUI/E2E 及打包验收由主集成运行，本子项不把待运行的测试写成通过。

Main 的错误路径不得因清理调度失败重新显示应用窗口或重复执行安装器；主集成已保留安装器交接流程，清理失败单独诊断。

主集成补充：最终源码的真实更新交接 E2E 已通过（5.3 秒），见 `artifacts/serpent-031-source-final-e2e.log`。归档下载、SHA-256、解压、应用退出与系统隐藏进程实际删除临时安装器均已执行；安装器本身为惰性测试文件，没有执行系统安装。
