# 上游 142 路径逐项处置

来源固定为 `03c99c0b..7a94cabc`。下表记录源码处置，不代表所有平台均已实机验收；测试结果与限制见本目录各审计及 README。新增文件可采用经审阅的上游实现，已有文件只按差异区块合并。

| 上游路径 | 处置与验证归属 |
| --- | --- |
| `README.en.md` | 保留本项目完整说明；只更新上游来源与本次审计链接。 |
| `README.md` | 保留本项目完整说明；只更新上游来源与本次审计链接。 |
| `docs/developer/build-packaging.en.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `docs/developer/build-packaging.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `docs/developer/setup.en.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `docs/developer/setup.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `docs/user-guide/installation.en.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `docs/user-guide/installation.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `docs/user-guide/troubleshooting.en.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `docs/user-guide/troubleshooting.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `forge.config.ts` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `package-lock.json` | 上游仅改产品版本0.3.0→0.3.1，没有依赖变化；保留WorldlineBox独立0.1.0及锁文件。 |
| `package.json` | 只补快捷键E2E及native前置脚本，保留本项目名称、版本、依赖与其他全部脚本。 |
| `resources/media-binaries/README.md` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `resources/media-binaries/bundle-lock.json` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `resources/media-binaries/source-lock.json` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `resources/media-binaries/vcpkg/triplets/serpent-arm64-linux-static.cmake` | 新增为worldlinebox-arm64-linux-static.cmake；平台代码/门禁见platforms-audit。 |
| `scripts/appimage-docker.sh` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/make-appimage.mjs` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/media-binaries-lib.mjs` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/media-build/linux-arm64.sh` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/media-build/stage-vcpkg-bundle.mjs` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/release/lib.mjs` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/release/pipeline.mjs` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/release/publish-media-bundle.mjs` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/sqlite-vec-integrity.json` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/verify-mainline.mjs` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `scripts/verify-package.mjs` | 构建/媒体/文档增量；保留Windows/Mac可信锁，Linux arm64仍未晋升，见platforms-audit。 |
| `src/main/app-update-service.ts` | 更新/安装/扩展/媒体增量；对应unit与真实Main/Worker E2E列入验收。 |
| `src/main/application-menu.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/main/embedding-install.ts` | 受管理模型目录与传输yield增量；原Windows归档句柄保护保留，见io-audit。 |
| `src/main/extension-server.ts` | 更新/安装/扩展/媒体增量；对应unit与真实Main/Worker E2E列入验收。 |
| `src/main/index.ts` | 按快捷键/侧栏/安装器/模型探测/扩展合集分区合并，保留懒加载、自有模块和库会话边界。 |
| `src/main/library-request/embedding-models.ts` | 受管理模型目录与传输yield增量；原Windows归档句柄保护保留，见io-audit。 |
| `src/main/shortcut-bindings-store.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/main/viewer-video-shortcut-capture.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/main/viewer-video-shortcut-menu.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/main/windows-installer-cleanup.ts` | 更新/安装/扩展/媒体增量；对应unit与真实Main/Worker E2E列入验收。 |
| `src/preload/bridge/shell.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/preload/bridge/shortcuts.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/preload/index.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/App.tsx` | 按快捷键/侧栏/安装器/模型探测/扩展合集分区合并，保留懒加载、自有模块和库会话边界。 |
| `src/renderer/AppSettingsDialog.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/AppSettingsShortcutsPage.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/AudioPlayerControls.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/DimensionFilterBar.tsx` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `src/renderer/GifViewerPlayer.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/NavigationSidebar.tsx` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `src/renderer/PdfViewerSurface.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/VideoPlayerControls.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/app-settings-sections.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/asset-action-keyboard.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/commands/command-registry.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/folder-custom-order.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `src/renderer/folder-drag-drop.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `src/renderer/folder-shortcut-dispatch.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/folder-sort-preferences.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `src/renderer/global-zoom-shortcuts.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/i18n/catalogs/en.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/i18n/catalogs/zh-CN.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/main-menu-items.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/main.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/selection-keyboard.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/shortcut-provider.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/shortcut-runtime.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/shortcut-settings-model.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/styles.css` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/ui/islands-surfaces.css` | 增量合并；保留本项目品牌及既有逻辑，见整合验收。 |
| `src/renderer/unified-directory-nav.ts` | 增量合并；保留本项目品牌及既有逻辑，见整合验收。 |
| `src/renderer/use-browse-command-keyboard.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/use-collection-command-shortcuts.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/use-dialog-focus-trap.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/use-folder-command-shortcuts.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/use-folder-drag-drop-handlers.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `src/renderer/use-selection-keyboard.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/use-viewer-volume.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/use-viewer-zoom-pan.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/use-windows-browse-shortcut-bridge.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/use-workspace-mouse-navigation.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/video-player-controls.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/viewer-fit-shortcut.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/viewer-volume-preferences.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/workspace-discovery-shortcuts.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/workspace-mouse-navigation.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/renderer/zoomable-preview-image.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/application-menu.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/external-url.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/native-dialog-i18n.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/protocol/channels.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/shortcut-api.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/shortcut-bindings.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/shortcut-catalog.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/shortcut-resolution.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/shared/viewer-video-shortcuts.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `src/worker/legacy-semantic-cache.ts` | 现有destroy+await finished且带完整JSON尾部校验，已等价或更强；保留。见io-audit。 |
| `src/worker/library-service.ts` | 受管理模型目录与传输yield增量；原Windows归档句柄保护保留，见io-audit。 |
| `tests/e2e/app-update-handoff.test.ts` | 更新/安装/扩展/媒体增量；对应unit与真实Main/Worker E2E列入验收。 |
| `tests/e2e/asset-pagination.test.ts` | 测试增量合并；保留本项目原场景及库生命周期，新增侧栏真实鼠标与扩展合集独立E2E。 |
| `tests/e2e/context-menu.test.ts` | 测试增量合并；保留本项目原场景及库生命周期，新增侧栏真实鼠标与扩展合集独立E2E。 |
| `tests/e2e/custom-shortcut-runtime.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/e2e/custom-shortcuts.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/e2e/folder-batch-actions.test.ts` | 测试增量合并；保留本项目原场景及库生命周期，新增侧栏真实鼠标与扩展合集独立E2E。 |
| `tests/e2e/nav-pane-background.test.ts` | 测试增量合并；保留本项目原场景及库生命周期，新增侧栏真实鼠标与扩展合集独立E2E。 |
| `tests/e2e/selection-marquee.test.ts` | 测试增量合并；保留本项目原场景及库生命周期，新增侧栏真实鼠标与扩展合集独立E2E。 |
| `tests/e2e/shell-navigation.test.ts` | 测试增量合并；保留本项目原场景及库生命周期，新增侧栏真实鼠标与扩展合集独立E2E。 |
| `tests/unit/app-settings-sections.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/app-settings-shortcuts-page.test.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/app-update-service.test.ts` | 更新/安装/扩展/媒体增量；对应unit与真实Main/Worker E2E列入验收。 |
| `tests/unit/application-menu.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/audio-player-controls.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/collection-command-shortcuts.test.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/dimension-filter-bar.test.tsx` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `tests/unit/embedding-install.test.ts` | 受管理模型目录与传输yield增量；原Windows归档句柄保护保留，见io-audit。 |
| `tests/unit/embedding-llama-session.test.ts` | 现有fake已输出WORLDLINEBOX_EMBEDDING_STOP，等价上游；保留，见io-audit。 |
| `tests/unit/extension-message.test.ts` | 更新/安装/扩展/媒体增量；对应unit与真实Main/Worker E2E列入验收。 |
| `tests/unit/folder-custom-order.test.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `tests/unit/folder-drag-drop.test.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `tests/unit/folder-shortcut-dispatch.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/folder-sort-preferences.test.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `tests/unit/global-zoom-shortcuts.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/main-menu-items.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/media-binaries.test.ts` | 更新/安装/扩展/媒体增量；对应unit与真实Main/Worker E2E列入验收。 |
| `tests/unit/navigation-sidebar.test.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `tests/unit/plugin-ui-dialog-focus.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/selection-keyboard.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/shortcut-bindings-store.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/shortcut-bindings.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/shortcut-catalog.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/shortcut-runtime.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/shortcut-settings-model.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/sidebar-nav-row-state-surface.test.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `tests/unit/use-viewer-volume.test.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/use-viewer-zoom-pan-middle-button.test.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/video-player-autoplay.test.tsx` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/video-player-controls.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/viewer-fit-shortcut.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/viewer-video-shortcuts.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/viewer-volume-preferences.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/unit/windows-installer-cleanup.test.ts` | 更新/安装/扩展/媒体增量；对应unit与真实Main/Worker E2E列入验收。 |
| `tests/unit/workspace-mouse-navigation.test.ts` | 快捷键路径；增量/适配详情见shortcuts-paths.json和shortcuts-audit。 |
| `tests/worker/folder-custom-cover.test.ts` | 侧栏/筛选增量；见sidebar-audit与io-audit。 |
| `tests/worker/library-zip.test.ts` | 现有await closeAllAsync及异步有界rm重试优于上游同步清理，保留，见io-audit。 |
