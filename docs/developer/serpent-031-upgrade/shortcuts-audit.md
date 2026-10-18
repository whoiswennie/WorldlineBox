# 自定义快捷键增量审计

来源固定为本机 Serpent `03c99c0b → 7a94cabc`（包含 0.3.1 发行 `2900be49`）。本项没有替换 WorldlineBox 大入口或整体代码；先以品牌名称转换后的上游基线作三方比对，再合并对应区块。新增上游文件可以逐个引入，已存在文件均保留本地分支变更。精确文件列表同时保存在 `shortcuts-paths.json`。

## 上游路径及处理

以下均在 `upstream-paths.txt` 的 142 个路径内：

| 路径 | 同步内容与保留方式 |
| --- | --- |
| `src/shared/shortcut-{api,bindings,catalog,resolution}.ts` | 新文件；动作目录、平台默认值/别名、仅存覆盖值、取消绑定、作用域冲突/系统保留键检查、键盘与修饰鼠标侧键统一匹配。API 使用 `WorldlineBoxShortcutsApi`、`window.worldlinebox.shortcuts`。 |
| `src/shared/application-menu.ts` | 从同一目录计算 native menu 动态 accelerator，含撤销、选择、缩放与全屏；原产品名、应用菜单结构保留。 |
| `src/shared/viewer-video-shortcuts.ts` | 视频与音频分作用域；暂停、帧、跳转、速率、音量、适应窗口等由目录解析；Main IME fallback 与 renderer 共用路由。 |
| `src/shared/external-url.ts` | 全量核对本次上游增量：`ViewerShortcutScope`、`nativeEditCommand`、`setViewerVideoShortcutsActive(active, scope)`、`setApplicationShortcutAcceleratorsEnabled` 均接入。额外可选 `fullscreenOnly` 仅用于 WorldlineBox 外层模块，保留已有 API。 |
| `src/shared/native-dialog-i18n.ts` | `exportShortcuts` / `importShortcuts` 类型及中英文标题、按钮、过滤器全部接入，其他 native dialog 不变。 |
| `src/shared/protocol/channels.ts` | 加入四个快捷键设置 IPC、native edit、application accelerator IPC；使用 WorldlineBox channel 前缀。 |
| `src/main/shortcut-bindings-store.ts` | 本机 `userData/shortcut-bindings.json` 读写；容错解析、保留未知动作及另一平台覆盖。 |
| `src/main/application-menu.ts` | 移除旧硬编码 accelerator 来源，菜单安装、重建与 Viewer 菜单均传当前绑定；品牌保持 WorldlineBox。 |
| `src/main/viewer-video-shortcut-{capture,menu}.ts` | hidden menu / before-input / IME suspend 的视频、音频和应用作用域接入，保留重复输入去重与文本输入让键。 |
| `src/main/index.ts` | 仅取 15 个上游快捷键 hunk：导入、菜单重建、读写/导入/导出、IPC、Main fallback、viewer scope。清理/更新 fixture/embedding/合集区块由根代理独立合并。新增 IPC 只接受主窗口 mainFrame。导出默认名为 `worldlinebox-shortcuts.json`。 |
| `src/preload/bridge/{shortcuts,shell}.ts` | 设置 API 校验、native edit、viewer scope 与 application accelerator 桥。 |
| `src/preload/index.ts` | 三方合并，仅主窗口 bridge 增加 shortcuts；截图工具与伙伴世界窗口仍仅暴露各自最小 API。 |
| `src/renderer/{shortcut-provider,shortcut-runtime,shortcut-settings-model}.ts*` | 设置上下文、同步 matcher 镜像、统一 keyboard/side-button 事件、搜索/分组/修改和冲突过滤。 |
| `src/renderer/AppSettingsShortcutsPage.tsx` | 录键、修饰鼠标侧键、确认/取消、冲突反馈、取消绑定、单项/全部恢复、导入/导出；设置内生效与菜单重建。 |
| `src/renderer/{AppSettingsDialog.tsx,app-settings-sections.ts}` | 三方合并“快捷键”分类；原用户资料、全局工具快捷键、全局模型、音乐和插件分类保留。 |
| `src/renderer/main.tsx` | 手动解决 lazy 多窗口入口冲突；仅主 Application 包 ShortcutProvider，不改启动边界、Suspense、React root HMR 或工具/伙伴窗口分流。 |
| `src/renderer/App.tsx` | 分区块合并匹配、菜单、缩放、查看器、焦点恢复、修饰鼠标侧键；三处冲突保留 `isModuleActive`、effect 依赖和新的 bridge 字段。合集排序六个 hunk 交根代理合并。 |
| `src/renderer/{asset-action-keyboard,selection-keyboard,folder-shortcut-dispatch,global-zoom-shortcuts,viewer-fit-shortcut,viewer-volume-preferences,video-player-controls,workspace-discovery-shortcuts,workspace-mouse-navigation}.ts` | 原硬编码入口转共享 runtime；固定 Escape、无修饰历史侧键与滚轮行为保留。 |
| `src/renderer/commands/command-registry.ts` | Context menu 标注读取 runtime；额外修复取消绑定后 null 被 legacy label 回退为旧快捷键的问题。未知插件动作仍可用自己的 legacy 规格。 |
| `src/renderer/main-menu-items.ts` | 动态快捷键、查看/缩放菜单动作与菜单状态收集同步。 |
| `src/renderer/use-{browse-command-keyboard,collection-command-shortcuts,folder-command-shortcuts,selection-keyboard,viewer-volume,viewer-zoom-pan,windows-browse-shortcut-bridge,workspace-mouse-navigation}.ts` | 浏览/侧栏/查看器/音频快捷键与修饰侧键接入；浏览与应用键独立启用，非当前资产模块不争抢外层模块所有权。 |
| `src/renderer/{AudioPlayerControls,VideoPlayerControls,GifViewerPlayer,PdfViewerSurface}.tsx`、`zoomable-preview-image.tsx` | 音视频、GIF、PDF、图片 fit / zoom / rate 等实际消费点同步。 |
| `src/renderer/use-dialog-focus-trap.ts` | 新增 `hasActiveModalDialog`，同时保留 WorldlineBox 对 retained view 的 hidden/inert 祖先检查；关闭/隐藏的对话框不占键。 |
| `src/renderer/i18n/catalogs/{en,zh-CN}.ts` | 只加入 shortcuts 对象与 categoryShortcuts；既有全局模型/音乐/全局工具文案保留，`nav.sortByCustom` 由侧栏代理同步。 |
| `src/renderer/styles.css` | 只追加上游 Custom keyboard shortcuts settings 样式块（497 行）；侧栏/标题栏/主题调整由侧栏代理合并，未互相覆盖。 |

## WorldlineBox 保留与补充

- 保留 `CaptureToolsService` 原设置文件、全局截图/录屏/划词助手快捷键、系统注册方式与 lazy import；用 `src/shared/capture-shortcut-conflicts.ts` 和 service validation callback 做双向冲突检查。冲突时不写设置、不注销原热键，UI 显示全局工具冲突原因。导入也检查。
- `src/renderer/use-application-module-shortcuts.ts`、`Application.tsx`：默认启动器尚未加载资产 App 时、浏览器/伙伴/全局网络模块中，全屏仍由外层主壳处理。Main `fullscreenOnly` 模式只接管全屏，其他模块文本复制粘贴不变；资产页恢复后恢复完整应用键。
- `src/main/browser/service.ts`：真实原生网页的 before-input 也读取全局自定义全屏绑定，改键后不再保留固定 F11 后门；原浏览器快捷键、网页采集、导航、持久化不变。
- `src/main/window-controls.ts`：macOS native menu 全屏改为自定义命令后，需要允许已验证主窗口的 `fullscreen-toggle`；其他 caption 动作仍保持原平台限制。
- 产品名、应用 ID、用户目录、远程仓库与自有版本不改；没有复制上游完整 App、Main 或其他模块。

## 测试与待验收

- 已执行 targeted Vitest：**28 files / 221 tests 通过**。覆盖上游目录/存储/冲突/录键/导入导出模型、菜单/资产/侧栏/查看器/音量/缩放；补充全局工具冲突、拒绝写盘/替换注册、外层模块所有权、hidden menu fullscreenOnly、取消绑定标注等。
- Owned ESLint：**0 errors / 2 既有 App hooks warnings**；没有新增警告。
- 整仓 TypeScript 与扩展类型检查由根代理统一复核；本项最后的 Playwright evaluate 泛型推断问题已改为 string 入参后内部收窄。
- 未在子代理运行 GUI、打包或 Git 提交。以下 E2E 已准备，由根代理运行真实源构建和打包构建：
  - `tests/e2e/custom-shortcuts.test.ts`：preload → Main 持久化、导出、导入及重启；适配 WorldlineBox 启动环境和 packaged 参数。
  - `tests/e2e/custom-shortcut-runtime.test.ts`：启动 DSH 后先切资产模块；实际媒体播放、菜单键、文本让键、全屏、查看器、鼠标侧键；上游 raw RGB / PCM fixture 保留且本机 ffmpeg encoder 已核对。
  - `tests/e2e/custom-shortcut-worldlinebox.test.ts`：冷启动未挂资产 App、真实本地浏览器网页 WebContentsView 焦点、模块切换、取消旧 F11、原生全屏调用次数与双向全局热键冲突；保留真实 BrowserWindow.setFullScreen 实现，仅观察调用。

上游另外六个既有 E2E 的 raw ffmpeg fixture / 侧栏场景增量 **不由本子任务修改**，已明确交根代理处理：`asset-pagination.test.ts`、`context-menu.test.ts`、`folder-batch-actions.test.ts`、`nav-pane-background.test.ts`、`selection-marquee.test.ts`、`shell-navigation.test.ts`。`ui/islands-surfaces.css`、侧栏排序及筛选对应路径由侧栏子任务审阅。

Windows 实机结果、BAT 02 / 03、打包功能与最终远程提交，以根代理最终验收记录为准。macOS/Linux 的本机实测不能由 Windows 上的单元测试替代。

## 真实回归后修正

根代理 source E2E 中，冷启动主壳、真实网页全屏和完整资产查看器链已分别运行。补正两处 WorldlineBox 测试定位：设置点击全局侧栏；`main.app-shell` 排除 theme portal。模块循环中的浏览器继续向真实网页 WebContents 发键，并独立验证 native fullscreen menu 的启用状态。

第三轮 trace 暴露一个实际运行时问题：资产页两次独立 keydown 相隔 14 ms，旧 `forwardApplicationShortcutToWindow` 复用视频的 50 ms 同动作节流，误吞第二次按键。新增 `src/shared/application-shortcut-dedupe.ts`：按窗口、动作和来源去重，只抑制 `menu` 与 `before-input` 交叉的重复；同一来源的后续独立按键立即允许。Main 原有 auto-repeat 阻断保留。新增三个针对性 unit 案例，由根代理统一运行。

全屏 E2E 同时等待真实 BrowserWindow `enter-full-screen` / `leave-full-screen` 事件与状态、调用次数全部吻合后再发下一键，避免把 `isFullScreen()` 已变值当成原生转换已完成。没有增加固定睡眠或放宽次数断言。
