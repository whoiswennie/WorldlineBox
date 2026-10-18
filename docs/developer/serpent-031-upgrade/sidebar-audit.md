# 侧栏排序与相关 UI 增量

上游范围：`03c99c0b` → `7a94cabc`，包含 `2900be49` 的 0.3.1 发行与之后的侧栏修正。

## 逐项处理

| 上游路径 | WorldlineBox 的处理与保留 |
| --- | --- |
| `src/renderer/folder-custom-order.ts` | 新增按资源库 ID 保存的设备本地排序。文件夹与合集使用不同的 `worldlinebox.*-custom-order.v1.<libraryId>` key；按父节点分别记录位置，移动期间不改变旧父节点的顺序。兼容上游早期扁平位置格式。 |
| `src/renderer/folder-sort-preferences.ts` | 增加 `custom`，新配置默认自定义；已有按名称、创建时间、数量及升降序设置继续有效，未重置老用户偏好。保留 WorldlineBox 存储命名。 |
| `src/renderer/unified-directory-nav.ts` | 每层兄弟分别排序，自定义顺序不受升降序影响，未排序行按原名称兜底；继续使用现有 managed/linked 统一目录结构。 |
| `src/renderer/folder-drag-drop.ts` | 抽出目标父节点有效性校验，防止向自身及后代移动。保留普通拖放、跨目录移动、批量回收站等既有逻辑。 |
| `src/renderer/NavigationSidebar.tsx` | 自定义模式的顶部/底部 30% 提示前后插入，中间区域保留移入目录/合集。跨层级调用既有移动 API；相同父级仅修改排序，不移动磁盘数据。合集与文件夹都有插入线；保留搜索、展开、Ctrl 多选、链接目录、原生文件导入与 WorldlineBox 菜单。 |
| `src/renderer/use-folder-drag-drop-handlers.ts` | 自定义重排允许非阻塞 UI；普通移动仍使用 loading。防止同时提交第二次移动。另加库切换保护，异步旧库成功/失败不会给新库提示或刷新。 |
| `src/renderer/DimensionFilterBar.tsx` | “更多”仅负责展开维度，不再因可用性筛选而错误染色；实际启用的筛选条目/标签仍正确显示状态。 |
| `src/renderer/styles.css` | 仅合并插入线、侧栏统一高亮矩形和收起左栏后的标题栏宽度修正，保留 WorldlineBox 自定义主题、系统字体及模块样式。 |
| `src/renderer/ui/islands-surfaces.css` | 新 UI 卡片选中描边改为 hairline token。 |
| `src/renderer/i18n/catalogs/{en,zh-CN}.ts` | 仅新增 `nav.sortByCustom`，未替换已有文案或快捷键页区块。 |
| `src/renderer/App.tsx` | 主集成已手工合并六处最小接线：两个合集移动函数接受 `blockingUi`，两个 sidebar 回调转发该选项。库会话守卫继续保留。原审阅补丁留在本机 `artifacts/serpent-031-sidebar-app-integration.patch`。 |

这些路径原文件在品牌适配后与上次上游基线完全一致；以逐 hunk 差异合并，未覆盖整文件。上游新增文件经过本项目存储命名适配。额外修正多选拖到自身成员行时的无操作约定，避免其中其他成员被意外重排。

排序与上游一致属于设备本地视图偏好，按库隔离；未新增 Worker 表或资源库格式迁移。链接目录的导入、离线提示与物理目录操作沿用现有规则，没有用排序动作改变链接目录磁盘位置。

## 已执行验证

- 侧栏、排序、拖放、筛选相关单元：`node node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/unit/folder-custom-order.test.ts tests/unit/folder-drag-drop.test.ts tests/unit/folder-sort-preferences.test.ts tests/unit/unified-directory-nav.test.ts tests/unit/navigation-sidebar.test.ts tests/unit/dimension-filter-bar.test.tsx tests/unit/sidebar-nav-row-state-surface.test.ts`：7 文件、112 项通过。
- 异步排序专测：`tests/unit/folder-reorder-handlers.test.tsx`：4 项通过，覆盖并行提交拦截、失败释放、库切换后的成功和失败。
- 上述源代码、单测及新增 E2E 的 ESLint：0 错误、0 警告。

## 主流程需要运行

`tests/e2e/sidebar-custom-order.test.ts` 使用实际鼠标触发 Chromium 拖放，不注入拖放结果；包含文件夹和合集同级重排、跨层级前插、禁止形成循环、Worker 持久化层级核对、按库 key 与 renderer 重载后的排序。此分工只编写，未运行 GUI，以免和其他验收抢占桌面。

另需主流程执行现有 `folder-batch-actions`、`nav-pane-background`、`shell-navigation`、筛选及完整打包回归，覆盖新/旧 UI、低高度与左栏收起状态。单元中的样式断言是辅助证据，不能代替实际界面检查。
