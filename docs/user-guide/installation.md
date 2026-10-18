# 安装

最新安装包见 [WorldlineBox Releases](https://github.com/whoiswennie/WorldlineBox/releases)。

## 系统要求

- macOS：Apple Silicon（arm64）或 Intel（x64），macOS 11 或更高版本
- Windows：64 位 Windows 10 或 Windows 11
- Linux：预览构建目标为 x86_64 / aarch64，采用 Ubuntu 22.04 / glibc ≥ 2.35 基线；aarch64 媒体包尚未晋升，当前不能视为发布就绪
- 应用本身约需 500 MB；资源库数据另占空间

实际提供的平台安装包和版本说明以 [WorldlineBox Releases](https://github.com/whoiswennie/WorldlineBox/releases) 为准。源码包含构建支持，不表示所有平台已有下载或已通过实机验收。

## macOS

1. 下载对应架构的 `WorldlineBox-darwin-arm64-<版本>-package.dmg`（或 Intel 架构对应安装包）。
2. 打开 DMG，将 WorldlineBox 拖到「应用程序」。

当前开发版若未签名公证，首次打开时右键应用选择「打开」并确认。若系统仍阻止，可以在终端清除隔离属性：

```bash
xattr -cr /Applications/WorldlineBox.app
```

卸载只需将应用移入废纸篓；资源库位于创建时选择的位置，不会因删除应用而删除。

## Windows

1. 从发布页下载 Windows 安装包 `WorldlineBox-win-x86-64-<版本>-setup.zip`（解压运行内含的安装向导进行安装），或下载便携版 `WorldlineBox-win-x86-64-<版本>-portable.zip`（解压到任意本地目录即可直接运行）。
2. 运行安装程序并按向导选择安装路径、语言等偏好完成安装。

未签名开发包可能触发 SmartScreen，请核对来源后选择「更多信息 → 仍要运行」。通过系统「设置 → 应用」卸载，卸载程序会干净移除安装文件。

## Linux（预览）

如果发布页提供与你机器架构匹配的 AppImage，可下载 x86_64 的 `WorldlineBox-linux-x86-64-<版本>.AppImage`，赋予执行权限后运行：

```bash
chmod +x WorldlineBox-linux-x86-64-<版本>.AppImage
./WorldlineBox-linux-x86-64-<版本>.AppImage
```

aarch64 对应的规范名称是 `WorldlineBox-linux-arm64-<版本>.AppImage`，但本次源码同步时该架构仍缺少已晋升媒体包，不承诺发布页已有现成文件。不要在不同架构间混用 AppImage。

- 需要 FUSE（如发行版中的 `libfuse2`）；不能使用 FUSE 时可加 `--appimage-extract-and-run`。
- 通过正式门禁构建的 AppImage 内置 `ffmpeg`、`ffprobe` 和 `oiiotool`，通常无需自行安装这些预览工具。开发源码未获取媒体包时仍可能依赖 PATH。可用 `WORLDLINEBOX_FFMPEG_PATH` / `WORLDLINEBOX_OIIO_PATH` 指定可信副本。
- Linux 使用应用内主菜单和无边框窗口；圆角依赖合成器。可用 `WORLDLINEBOX_LINUX_ROUNDED_CORNERS=0` / `1` 强制直角或圆角，无可用 GPU 时可试 `WORLDLINEBOX_SOFTWARE_GL=1`。
- Linux 暂不提供 Windows 托盘驻留和「登录时启动」。截图、录屏、系统声音与快捷键可能受桌面环境和权限机制影响，X11 与原生 Wayland 需分别验证。
- 本轮在 Windows 开发机完成源码与跨平台单元检查，没有进行 WorldlineBox 的 Linux 构建或实机验收；不沿用上游的测试机器结果作为本项目的验收结果。

卸载时删除 AppImage 即可；资源库位于独立目录，不随该文件删除。

## 浏览器扩展

从[扩展发布页](https://github.com/dolag233/WorldlineBox-Extension/releases)下载浏览器扩展（Chrome / Edge / Firefox），安装与使用见[浏览器扩展](browser-extension.md)。

## 升级

macOS 用新 DMG 替换应用，Windows 运行新版安装程序覆盖安装，Linux 用匹配架构的新 AppImage 替换旧文件（确认新版可用前先保留旧文件）。资源库目录和用户配置独立于应用安装目录，通常会保留；升级前建议备份资源库。跨版本迁移和平台差异请以发布说明为准。

Linux 更新器按当前运行架构寻找上述 AppImage 及校验文件；下载校验后仍需给予执行权限。发布页未提供该架构制品时，应等待相应版本发布，不用其他架构文件替代。
