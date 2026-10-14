# Third-Party Notices

## 资产管理基础的来源

WorldlineBox 的资产管理、媒体处理、插件、脚本与 MCP 基础来自 dolag233 及原项目贡献者的 MIT 代码。原始版权通知保存在根目录 LICENSE；WorldlineBox 的新定位、品牌、Windows 一键入口与后续生态功能由本项目继续维护。产品改名不改变上游及第三方组件的权利归属。

WorldlineBox (MIT, see [LICENSE](LICENSE)) 依赖以下开源组件。各组件按其自身许可证提供；完整许可证文本随依赖包或下方链接分发。

## 运行时依赖

Windows x64 启动器另行携带独立命令行工具，置于 `resources/portable-tools/win32-x64`，不要求用户安装或修改系统环境变量。Node.js 24.15.0 / npm 11.12.1 / pnpm 11.7.0 使用 MIT 及包内第三方许可；CPython 3.13.12 使用 PSF 许可，附带 pip 25.3（MIT）；Git for Windows 2.48.1 使用 GPLv2 及其组件许可；用户指定的 Gyan FFmpeg / ffplay / ffprobe 8.0.1 essentials 使用 GPLv3，原始许可证与完整构建配置保存在工具目录。各工具保持独立进程，资产 Worker 的 LGPL FFmpeg 清单继续单独校验。来源与对应源码链接详见随包 `SOURCES.md`；公开分发 Git / FFmpeg 二进制时，还须按各自许可证提供包含启用依赖的对应源码。

Windows 安装器简体中文翻译来自 [kira-96/Inno-Setup-Chinese-Simplified-Translation](https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation)，使用 MIT 许可；原始署名保留在 `assets/inno/ChineseSimplified.isl`，许可全文随安装器安装到 `resources/ChineseSimplified.LICENSE.txt`。

| 组件 | 许可证 | 用途 |
|---|---|---|
| [Electron](https://www.electronjs.org/) | MIT | 桌面应用运行时 |
| Chromium (随 Electron) | BSD-3-Clause | 浏览器内核 |
| [React / React DOM](https://react.dev/) | MIT | 界面渲染框架 |
| [Vite](https://vitejs.dev/) | MIT | 构建工具（打包产物含构建产物） |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 | 类型系统与编译器 |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | SQLite 绑定 |
| [SQLite](https://www.sqlite.org/copyright.html) | Public Domain | 本地资源库数据库 |
| [Sharp](https://sharp.pixelplumbing.com/) | Apache-2.0 | 图像处理（libvips） |
| [FFmpeg](https://ffmpeg.org/)（BtbN builds） | LGPL-2.1 | 媒体解码/编码；许可证文本随包分发于 `resources/media-binaries/<platform>/licenses/` |
| [OpenImageIO (OIIO)](https://sites.google.com/site/openimageio/) | BSD-3-Clause | 图像处理管线（EXR 等） |
| [three.js](https://threejs.org/) | MIT | 3D 模型查看 |
| [exifr](https://github.com/MikeKovarik/exifr) | MIT | EXIF 元数据解析 |
| [koffi](https://koffi.dev/) | MIT | 原生函数 FFI 绑定 |
| [QuickJS](https://bellard.org/quickjs/)（[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)） | MIT | 脚本运行时（自动化脚本） |
| [adm-zip](https://github.com/cthackers/adm-zip) | MIT | ZIP 读取 |
| [archiver](https://github.com/archiverjs/node-archiver) | MIT | ZIP 写入 |
| [yauzl](https://github.com/thejoshwolfe/yauzl) | MIT | ZIP 解压 |
| [libarchive-wasm](https://github.com/ofk/libarchive-wasm) | MIT | ZIP、RAR、7z、TAR 等外部资源库归档读取 |
| [Zod](https://zod.dev/) | MIT | 跨进程协议运行时校验 |
| [trash](https://github.com/sindresorhus/trash) | MIT | 系统回收站 |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP 服务器 |
| [ufbx](https://ubfgfx.com/)（`resources/ufbx/`，WASM） | MIT | FBX 解析与转换 |

## 字体

| 字体 | 许可证 | 用途 |
|---|---|---|
| [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)（[@fontsource-variable/noto-sans-sc](https://github.com/fontsource/fontsource)） | SIL OFL-1.1 | 界面中文字体 |
| [IBM Plex Mono](https://github.com/IBM/plex)（[@fontsource/ibm-plex-mono](https://github.com/fontsource/fontsource)） | SIL OFL-1.1 | 等宽字体（文件名/元数据） |
| [HarmonyOS Sans SC](https://developer.huawei.com/consumer/cn/design/resource/)（[harmonyos-sans-sc-webfont-splitted](https://github.com/...)） | © Huawei；npm 包装为 Unlicense | 界面中文字体 |

> HarmonyOS Sans 字体版权归华为所有，华为授权免费使用（需保留版权声明）；npm 分包仓库以 Unlicense 声明其打包内容。正式对外发布前请按华为官方许可条款复核署名要求。

## 开发与构建工具（不随产物分发）

Electron Forge (MIT)、@electron/rebuild (MIT)、ESLint (MIT)、Playwright (Apache-2.0)、node-gyp (MIT)、Inno Setup（免费使用，非开源）、vcpkg (MIT)、Emscripten (MIT/BSD，构建 ufbx WASM 时)、BtbN FFmpeg-Builds（LGPL）。

## 两套动态背景

「鲸鱼娘 · 未至之境」和「鲸鱼娘 · 水墨丹青」来自
[dsh-web](https://github.com/zhu1090093659/dsh-web/tree/b89497fe1eb8436285b0a984e4261b47685b227a/market/dist/assets/skins)，
皮肤作者为 stushansusu。上游皮肤事实源是 dsh-skins；本次仅提取这两套原视频、
从视频生成静态封面，并将配色适配到 WorldlineBox，没有引入 DSH 插件或宠物。
视频文件未经重新编码、剪辑或调色。

这部分素材不属于 WorldlineBox 的 MIT 许可。两套 skin.json 声明 CC BY-NC-SA 4.0；
水墨丹青的 README 另有对美术素材授权范围的说明。上游 LICENSE、README 和清单
原文保存在 `assets/backgrounds/attribution/<skin>/`，应用包中保存在 `attribution/<skin>/`。
来源提交、字节数和 SHA-256 保存在 `assets/backgrounds/sources.json`。

## 完整许可文本

DSH 安装包提取使用 [7zip-bin 5.2.0](https://github.com/develar/7zip-bin) 的未修改 7za 二进制（Windows x64 21.07）。npm 包装代码采用 MIT，7-Zip 二进制采用 LGPL-2.1-or-later；本项目通过独立进程调用它。许可证保存在 `resources/dsh-tools/`，随应用资源分发。7-Zip 的原始源码与历史版本可从 [7-Zip 官方下载目录](https://www.7-zip.org/download.html) 获取。本项目不把 7-Zip 二进制或用户获取的 DSH 程序归入 WorldlineBox 的 MIT 许可。

- 主项目：`LICENSE`（MIT）
- 媒体二进制（ffmpeg/OIIO）：`resources/media-binaries/<platform>/licenses/`（随 media 包分发）
- ufbx：`resources/ufbx/LICENSE`
- 各 npm 依赖：`node_modules/<包名>/LICENSE*`（随源码构建时可用）

## 内置伙伴参考图

`assets/companions/deepseek.jpg`、`deepseek-sister.jpg` 与 `deepseek-flash.jpg` 为维护者在设计请求中提供的第三方角色参考图，用于大肥鱼姐妹的联系人形象。图片不属于 WorldlineBox 的 MIT 源码许可。

公开形象调研参考上善无形的[原型说明](https://www.bilibili.com/opus/1231977657712771073)与 [ZipZipPipe](https://space.bilibili.com/4168597) 的女仆形象。原型的许可说明不自动涵盖维护者提供的每张二创设定图；这些具体图片的作者及许可尚未独立确认。本项目的姐妹人格、提示与聊天实现为独立设计，不声明为 DeepSeek 官方人设。

## worldline-harness 网易云音乐播放器

本项目移植并改写了 worldline-harness 的 `packages/host/netease-music` 和 `packages/client/ui-netease-music` 源码：公开歌单与歌词解析、播放与歌词同步、歌单管理。使用 WorldlineBox 自有 IPC、全局用户数据存储与设置界面。网易云歌曲与服务由其权利人提供，不属于随安装包分发的代码许可。

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 旧项目伙伴形象与新绘聊天头像

2026-10-14 从维护者指定的旧 WorldlineBox 工作区承接 13 位角色的作者设定，并使用内置 imagegen 依据旧身份参考重新绘制聊天头像。白幻、黑幻为旧项目原创角色；Gemini、GPT、Grok、Kimi、MiniMax、Qwen 为旧项目采用的社区 AI 拟人形象，系列来源可核对 ZipZipPipe 的《大AI和小AI们》。相关公司名称只用于虚构角色身份，不声明官方角色、合作或模型绑定。

咕咕嘎嘎为高松灯企鹅分支（原角色关联 BanG Dream!），咕嘎为女管理员企鹅分支（原角色关联明日方舟：终末地）；Doro 为 NIKKE / SHIFT UP 相关社区 Q 版形象；菲比啾比与弗糯糯分别为鸣潮 / Kuro Games 角色的社区演绎。具体参考以维护者旧项目素材为准；不随本项目搬运社区视频、模型或远程原图。

头像生成不移除底层人物设计的第三方来源，也不将这些设计自动纳入本项目 MIT 代码许可。原作者在鲸鱼娘系列说明中声明上善无形来源及 CC BY-NC-SA 4.0 非商业同协议使用；各其他参考图的具体授权没有由本次重绘重新确定。完整来源、核对范围和提示词见 `docs/developer/companion-catalogue.md` 与 `assets/companions/portraits/manifest.json`。
