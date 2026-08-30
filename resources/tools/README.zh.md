# Worldline 原生视频工具

[English](README.md) | 中文

这些可执行文件是 Worldline 桌面应用的发行输入，不会在开发期间全局安装。Windows 辅助安装程序会将它们部署到 `resources/tools/`，把两个准确的二进制目录追加到所选的全体用户或当前用户 `PATH`，并在卸载时仅移除这些条目。

## Windows x64 清单

| 文件 | 版本 | SHA-256 | 上游来源 |
| --- | --- | --- | --- |
| `ffmpeg/windows-x64/ffmpeg.exe` | 8.0.1 essentials build | `5AF82A0D4FE2B9EAE211B967332EA97EDFC51C6B328CA35B827E73EAC560DC0D` | [gyan.dev FFmpeg 构建](https://www.gyan.dev/ffmpeg/builds/) |
| `ffmpeg/windows-x64/ffprobe.exe` | 8.0.1 essentials build | `192A1D6899059765AC8C39764FC3148D4E6049955956DC2029F81F4BD6A8972D` | [gyan.dev FFmpeg 构建](https://www.gyan.dev/ffmpeg/builds/) |
| `ffmpeg/windows-x64/ffplay.exe` | 8.0.1 essentials build | `A8E01921B808D9A6893EBAAF3B461BD7620424FC870CEB9D8768794FB72BE613` | [gyan.dev FFmpeg 构建](https://www.gyan.dev/ffmpeg/builds/) |
| `yt-dlp/windows-x64/yt-dlp.exe` | 2026.08.19 | `66674953FE251B89F4D08C5F0E35E0728679BD67AB3D7D05C0562AF101DD3E7A` | [yt-dlp 官方发行版](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19) |

FFmpeg 保留的 `README.txt` 标明了准确的上游源码提交与构建配置；相邻的 `LICENSE` 文件是再分发条款的权威依据。可执行文件由 Git LFS 跟踪，因此用于打包的克隆必须先完成 `git lfs pull`，再执行常规构建。
