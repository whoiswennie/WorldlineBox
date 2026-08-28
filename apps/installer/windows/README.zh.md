# WorldlineBox Windows 安装器

[English](README.md) | 中文

Windows 发布版本使用原生、自绘的 WPF 安装器，而不是 NSIS 用户界面。同一个可执行文件包含安装、进度、完成、卸载、卸载进度和卸载完成界面。

## 打包格式

`scripts/build-custom-installer.mjs` 会编译 `WorldlineInstaller.cs`，从 Electron 的 `win-unpacked` 目录创建 ZIP，并将其附加到原生可执行文件。24 字节的尾部保存 `WLBOX001` 签名、载荷偏移量和载荷长度。安装器直接打开这个有界流，逐个验证目标路径以防路径遍历，并在自己的界面中报告解压进度。

已安装的卸载器只包含轻量原生前缀，不会再次复制应用载荷。

Electron 可执行文件以 `WorldlineBox.exe` 名称存入 ZIP。打包器会在归档后恢复本地化的 `win-unpacked` 文件名，并拒绝任何剩余的非 ASCII 载荷路径，避免 Windows ZIP 文件名编码损坏已安装文件。

## Windows 行为

- 最终目录名始终为 `WorldlineBox`。选择 `D:\Apps` 时会安装到 `D:\Apps\WorldlineBox`；选择这个最终目录时则保持不变。
- 默认目录是 `C:\Program Files\WorldlineBox`，发布版本会请求提权。
- 仅在用户选中时创建桌面和开始菜单快捷方式。
- 「程序和功能」指向自定义 WorldlineBox 卸载器。
- 启动更新时会传入运行中应用的 PID 和当前安装目录的准确路径。安装器等待应用退出、锁定路径选择器，并在同一目录中替换应用，同时保留 `.worldline` 用户数据。
- 随附的 FFmpeg 和 yt-dlp 目录会添加到计算机 PATH，且不使用 `setx`。
- 卸载会移除应用文件、快捷方式、注册表项和准确匹配的 PATH 项。用户拥有的 `.worldline` 数据位于安装根目录之外，会被有意保留。

## 命令

```powershell
pnpm run package:installer-preview
node scripts/build-custom-installer.mjs --input release/desktop/win-unpacked `
  --output release/desktop/WorldlineBox-Setup-0.1.0.exe
```

`build-exe.bat` 会在构建并对解包桌面应用执行冒烟测试后，自动执行第二条命令。它还会在仓库根目录写入 `latest.yml`，其中包含安装包大小、SHA-512 摘要、GitHub Release URL、版本、日期和发布说明。在把该 manifest 发布到 `main` 之前，需要先把安装包上传到对应的 `v<version>` GitHub Release。
