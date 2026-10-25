# 验收记录

环境：Windows，本机 Electron 43.1.0；构建使用仓库已有 Node 24.15.0，原生 SQLite/图像测试通过 Electron 的 Node 运行时执行。来源固定为 Serpent `dbf4c27b`，验证日期为 2026-10-25。

## 静态与运行时检查

| 检查 | 结果 |
| --- | --- |
| TypeScript 主项目及浏览器扩展 | 通过。 |
| 本次修改文件 ESLint | 0 errors；大型既有模块保留 7 条 Hook 依赖 warning。后续补充模块单独检查为 0 errors / 0 warnings。 |
| `git diff --check` | 通过。 |
| 独立 E2E 应用构建 | `.tools/e2e-app` 中完成 Main、Preload、Worker、伙伴、插件与 Renderer 生产构建；未覆盖日常开发 `.vite`。存在原有大 bundle 提示。 |

测试日志保留在本机 `.tools/serpent-033/`，不会包含用户 API 密钥。

## 单元和 Worker 回归

不同组有交叉，不相加为唯一用例总数。

| 测试组 / 本机日志 | 结果 |
| --- | --- |
| 39 个单元文件：上游功能差异、自定义快捷键、分页、主题、控件等；`unit-tests.log` | 392 passed。 |
| 10 个预览/Worker 文件：缩略图队列、FBX 转换、链接文件、导入缩略图、可见窗口；`worker-tests.log` | 170 passed，1 skipped（既有可选用例）。 |
| 13 个本项目扩展回归文件：语义设置、内置模型偏好、全局服务、设备检测、绑定、应用模块快捷键及 UI；`custom-regression.log` | 117 passed。 |
| 7 个兼容性文件：语义索引读写及处理、schema 兼容/只读、导入缩略图和 offscreen；`compatibility-tests.log` | 124 passed。 |
| RGBA 异常数据、主题菜单和浮层定位；`refinement-tests.log` | 7 passed。 |
| 模型缩略图缓存升级及模型管线；`model-cache-tests.log` | 25 passed。 |
| 文件夹聚焦与路径快捷键；`folder-focus-tests.log` | 21 passed。 |

首次运行新增缩略图测试时，其上游硬编码的 `.serpent` 数据目录与本项目不同。已适配为 `.worldlinebox` 后重跑通过。

## 真实窗口验证

使用临时 profile / 资源库、真实 Main/Worker/Renderer 和真实模型/字体解码。模型测试明确使用 Chromium 软件 WebGL，验证正确性，不代表硬件帧率测试。

已验证 AI 配置编辑/切换/重启恢复、内置向量模型设置在亮/暗主题和窄窗口下可用、真实字体字形与语言菜单、OBJ/glTF/GLB/STL/FBX 缩略图、小图直接显示、自定义路径键录制与执行、原默认键停用、取消喜欢后在延迟 reconcile 前移出筛选、链接文件键盘强制删除及重新链接。

测试脚本适配了本项目先进入启动器的入口；模型卡片等待条件改为完成解码且宽高均大于零，避免把浏览器的 `complete=true, naturalWidth=0` 当成成功；模型工具栏交互先移动到已有的底部接近显示区域。未放宽渲染/删除/索引的功能断言。

最终补充结果：

- `viewer-e2e-final.log` 中 4 个模型查看器用例全部通过，包括双面/信息面板关闭重开、PBR 与灰模/网格状态、查看器文件路径快捷键、OBJ/FBX 解码和 HDRI 菜单。
- `targeted-e2e-final.log` 中筛选即时移除与自定义路径键、链接文件键盘强制删除/离线/重新链接、GLB 缩略图用例均通过。此前工具栏尚未接近显示区域的交互断言，经按本项目已有自动隐藏行为适配后在上组通过。
- `semantic-e2e-final.log`：真实自带模型编码 5 项文本/图片，全部写入 768 维 SQLite 向量；自然语言检索与相似图检索正确；完整重启后向量二进制和时间戳保持不变；清理运行缓存后仍保留内置模型文件且释放进程。1 个完整生命周期用例通过（1.2 分钟）。
- Windows 自定义应用全屏在启动器、浏览器聚焦和模块切换中通过，见 `e2e-tests.log` 的独立成功用例。

`video-e2e-verified.log`：原视频快捷键综合用例最终通过（1.6 分钟），覆盖自定义菜单加速键、输入框让键、键盘和鼠标侧键、播放暂停与倍速。此前媒体直接 `.pause()` 绕过播放器的用户暂停状态；测试准备动作改为调用播放器自己的暂停动作，避免 seek/canplay 自动播放与测试争抢状态。没有更改本项目播放器实现。

最终主项目与扩展 TypeScript 检查在 `typecheck-delivery.log` 中以 `EXIT=0` 完成；补充源码与测试 ESLint 在 `lint-final.log` 中以 `EXIT=0` 完成。

## 范围

没有重新打安装包、安装更新或发布版本；没有进行 macOS/Linux 真机测试和硬件 GPU 性能测量。现有用户资源库、全局模型配置、凭据和安装目录未被测试使用。`package.json`、锁文件、应用产品名、独立版本和用户目录保持不变。RGBA 贴图与模型卡片仅通过缓存生成器版本更新，不修改资产源文件，也不新增数据库迁移。

验收期间工作区并行出现 `src/main/vcp-memory/{cold-runtime,runtime}.cjs`、对应的两份 Worker 测试及 `tests/fixtures/vcp-no-directory-links.cjs` 的独立改动。它们不属于本次升级，本次未编辑或回退；交付时保留在工作区。
