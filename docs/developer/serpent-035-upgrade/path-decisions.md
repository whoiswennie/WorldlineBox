# 0.3.5 上游逐路径处置

对照 `bc28794b..d892b08f`，列出全部 106 个上游变更路径。独立新模块按需引入，现有文件按差异区块接入和适配。

| 上游路径 | 处置 |
| --- | --- |
| `docs/internal/前端参考/2026-07-16-eagle-filter-popover.png` | 上游内部图片删除不作用于本项目 |
| `docs/internal/前端参考/2026-07-16-eagle-layout-annotated.png` | 上游内部图片删除不作用于本项目 |
| `docs/internal/前端参考/2026-07-16-serpent-masonry-gap.png` | 上游内部图片删除不作用于本项目 |
| `docs/internal/前端参考/2026-07-16-tag-chip-reference.png` | 上游内部图片删除不作用于本项目 |
| `docs/internal/前端参考/2026-07-18-tile-layout-reference.png` | 上游内部图片删除不作用于本项目 |
| `docs/internal/前端参考/2026-09-04-folder-four-grid-collage-preview-reference.png` | 上游内部图片删除不作用于本项目 |
| `docs/internal/前端参考/Eagle前端参考.png` | 上游内部图片删除不作用于本项目 |
| `package-lock.json` | 保留 WorldlineBox 身份、版本和依赖，不合入发行版本号 |
| `package.json` | 保留 WorldlineBox 身份、版本和依赖，不合入发行版本号 |
| `scripts/kill-stale-dev.mjs` | 本项目已按当前 checkout 的 executable 和命令行限制清理范围，保留现有实现 |
| `scripts/run-e2e.mjs` | 本项目已有独立构建路径与目录防护；本次用专属临时构建，保留现有实现 |
| `src/main/ai-profile-store.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/main/ai-search-planner.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/main/application-menu.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/main/dev-renderer-load.ts` | 不引入重复 mount 轮询和模块再次注入；保留 StartupBoundary / RendererReady 启动握手 |
| `src/main/index.ts` | 手工接入同步调度区块；保留本项目启动握手、懒加载与日志流程 |
| `src/main/library-request/sync.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/main/normalize-automation-asset-search-input.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/main/renderer-diagnostics.ts` | 本项目已消费现代 Electron 日志事件并记录启动状态，保留现有实现与测试 |
| `src/main/sync-auto-scheduler.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/main/worker-client.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/AiConfigDialog.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/App.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/AppSettingsPages.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/AssetContextMenu.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/CollectionPickerMenu.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/DimensionFilterBar.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/FilterTagPicker.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/InspectorPanel.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/LibrarySettingsDialog.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/MainMenu.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/McpSettingsPage.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/ScriptSandboxPreviewDialog.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/SyncSettingsPage.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/active-discovery-filters.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/ai-config-number-input.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/browse-view-restore-scheduler.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/i18n/catalogs/en.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/i18n/catalogs/zh-CN.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/ime-safe-dismiss.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/main.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/search-expression.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/search-folder-results.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/search-history.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/styles.css` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/sync-settings-types.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/tag-expression-editor.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/theme/ThemeMiniDialog.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/ui/primitives/TextField.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/use-dialog-focus-trap.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/use-workspace-tab-shortcuts.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/view-restore.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/renderer/workspace-tabs.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/ai-endpoints.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/ai-request-policy.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/application-menu.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/asset-types.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/platform-shortcut-table.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/search-expression.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/shortcut-catalog.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/shortcut-resolution.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/shared/smart-collection-query.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/ai/anthropic-adapter.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/ai/dashscope-adapter.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/ai/gemini-adapter.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/ai/openai-adapter.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/ai/openai-response.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/catalog-read.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/library-service.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/sync/remote-storage.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `src/worker/sync/webdav-driver.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/e2e/organization-search-trash.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/e2e/sync-real-webdav-manual.test.ts` | 不复制用户真实凭据或写入真实远端；使用本地 WebDAV 阻塞传输验收 |
| `tests/e2e/sync-save-during-run.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/e2e/viewer-close-scroll-restore.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/scripts/kill-stale-dev.test.mjs` | 本项目已按当前 checkout 的 executable 和命令行限制清理范围，保留现有实现 |
| `tests/unit/active-discovery-filters.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/ai-endpoints.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/ai-profile-store.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/ai-protocol.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/ai-request-policy.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/ai-search-planner.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/application-menu.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/browse-view-restore-scheduler.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/dev-renderer-load.test.ts` | 不引入重复 mount 轮询和模块再次注入；保留 StartupBoundary / RendererReady 启动握手 |
| `tests/unit/filter-tag-picker.test.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/ime-safe-dismiss.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/library-settings-sync.test.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/main-sync-owned-request.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/normalize-automation-asset-search-input.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/renderer-diagnostics.test.ts` | 本项目已消费现代 Electron 日志事件并记录启动状态，保留现有实现与测试 |
| `tests/unit/search-expression.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/search-folder-results.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/search-history.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/sync-auto-scheduler.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/tag-expression-editor.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/use-filtered-folder-counts.test.tsx` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/view-restore.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/worker-client.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/workspace-tab-shortcuts.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/unit/workspace-tabs.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/worker/ai-completion.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/worker/catalog-read.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/worker/search.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/worker/webdav-driver.test.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
| `tests/worker/webdav-fixture-server.ts` | 增量接入并保留本项目差异；详见 README 与验收记录 |
