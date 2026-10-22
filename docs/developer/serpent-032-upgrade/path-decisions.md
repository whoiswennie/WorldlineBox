# 0.3.2 上游逐路径处置

范围：`7a94cabc..7e86e1b0`，共 107 个路径。旧文件以局部补丁同步，新模块按职责引入；未整体替换定制业务文件。

| 路径 | 处置 |
| --- | --- |
| `docs/assets/README.md` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/automation-script.en.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/automation-script.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/collections-inspector.en.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/collections-inspector.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/search-syntax.en.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/search-syntax.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/settings-appearance.en.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/settings-appearance.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/settings-browse.en.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/settings-browse.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/settings-shortcuts.en.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/settings-shortcuts.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/tag-management.en.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/assets/ui/tag-management.png` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/user-guide/automation.en.md` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/user-guide/automation.md` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/user-guide/basics.en.md` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/user-guide/basics.md` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/user-guide/search-and-filters.en.md` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `docs/user-guide/search-and-filters.md` | 保留 WorldlineBox 现有说明和截图；本次功能说明单独补充，避免引入 Serpent 品牌截图 |
| `eslint.config.mjs` | 增量合入；保留 WorldlineBox 的隔离输出目录与品牌环境变量 |
| `package-lock.json` | 上游仅改产品版本；保留 WorldlineBox 名称、0.1.0 版本、全部自有依赖与锁文件 |
| `package.json` | 上游仅改产品版本；保留 WorldlineBox 名称、0.1.0 版本、全部自有依赖与锁文件 |
| `playwright.config.ts` | 增量合入可选输出目录/快速失败；默认仍为本项目 .tools/test-output/playwright，避免重复 outputDir 配置 |
| `scripts/bench-import-acceleration.mjs` | 上游开发用性能探针，作为审阅参考；不作为运行时必需代码引入 |
| `scripts/bench-import-lookup-indexes.mjs` | 上游开发用性能探针，作为审阅参考；不作为运行时必需代码引入 |
| `scripts/bench-import-sequence-discovery.mjs` | 上游开发用性能探针，作为审阅参考；不作为运行时必需代码引入 |
| `scripts/bench-pr70-import.mjs` | 上游开发用性能探针，作为审阅参考；不作为运行时必需代码引入 |
| `scripts/repro-pr70-import-conflicts.mjs` | 上游开发用性能探针，作为审阅参考；不作为运行时必需代码引入 |
| `src/main/ai-analysis-preferences.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/main/ai-profile-legacy-config.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/main/ai-profile-store.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/main/ai-profile-transaction.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/main/index.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/main/library-request/ai.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/main/mcp-client-credentials.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/preload/bridge/library.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/preload/index.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/AiConfigDialog.tsx` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/App.tsx` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/AssetPreviewModal.tsx` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/McpSettingsPage.tsx` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/NavigationSidebar.tsx` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/ai-connection-probe-guard.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/ai-model-fetch-key.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/asset-drag-drop.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/external-import-transfer.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/i18n/catalogs/en.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/i18n/catalogs/zh-CN.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/mcp-settings-error.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/post-import-image-sequences.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/styles.css` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/renderer/use-external-import-handlers.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/shared/image-sequence.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/shared/library-api.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/shared/mcp.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/shared/protocol/errors.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/shared/protocol/requests.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/shared/protocol/responses.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/worker/image-sequence-import-discovery.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/worker/import-destination-directory-cache.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/worker/library-service.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/worker/media-memory-budget.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `src/worker/media-memory-concurrency.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/ai-inspector-refresh.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/ai-profile-switching.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/asset-ingestion.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/asset-pagination.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/automation-mcp-launcher.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/file-operation-process-recovery.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/media-preview.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/native-asset-drag-trash.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/e2e/windows-typography.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/ai-analysis-preferences.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/ai-connection-probe-guard.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/ai-model-fetch-key.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/ai-profile-legacy-config.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/ai-profile-store.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/ai-profile-transaction.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/asset-drag-drop.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/external-import-transfer.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/image-sequence.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/main-ai-owned-request.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/mcp-client-credentials.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/mcp-settings-error.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/media-memory-concurrency.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/navigation-sidebar.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/post-import-image-sequences.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/preload-mcp.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/public-error-catalog-gaps.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/unit/use-external-import-handlers.test.tsx` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/eagle-import.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/image-sequence.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/import-acceleration.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/import-destination-directory-cache.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/library-availability.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/library-create-rename-retry.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/library-export-import.test.ts` | 保留本项目可 yield 的异步 rm 清理重试；将重试次数/延迟与上游对齐为 10/200，避免同步等待阻塞 watcher 释放 |
| `tests/worker/library-service.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/library-watcher.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/migration-checksum-snapshot.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/schema-compatibility.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/semantic-index-handler.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/trash-relink.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `tests/worker/video-exr.test.ts` | 按功能逐块同步，保留本项目差异；详见升级与验收记录 |
| `vitest.config.ts` | 增量合入；保留 WorldlineBox 的隔离输出目录与品牌环境变量 |
