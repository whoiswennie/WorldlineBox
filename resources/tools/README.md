# Worldline native video tools

These executables are release inputs for the Worldline desktop application. They are not installed globally during development. The assisted Windows installer deploys them under `resources/tools/`, appends the two exact binary directories to the selected all-users or current-user `PATH`, and removes only those entries during uninstall.

## Windows x64 inventory

| File | Version | SHA-256 | Upstream |
| --- | --- | --- | --- |
| `ffmpeg/windows-x64/ffmpeg.exe` | 8.0.1 essentials build | `5AF82A0D4FE2B9EAE211B967332EA97EDFC51C6B328CA35B827E73EAC560DC0D` | [gyan.dev FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/) |
| `ffmpeg/windows-x64/ffprobe.exe` | 8.0.1 essentials build | `192A1D6899059765AC8C39764FC3148D4E6049955956DC2029F81F4BD6A8972D` | [gyan.dev FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/) |
| `ffmpeg/windows-x64/ffplay.exe` | 8.0.1 essentials build | `A8E01921B808D9A6893EBAAF3B461BD7620424FC870CEB9D8768794FB72BE613` | [gyan.dev FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/) |
| `yt-dlp/windows-x64/yt-dlp.exe` | 2026.08.19 | `66674953FE251B89F4D08C5F0E35E0728679BD67AB3D7D05C0562AF101DD3E7A` | [official yt-dlp release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19) |

FFmpeg's preserved `README.txt` identifies the exact upstream source commit and build configuration. The adjacent `LICENSE` files remain authoritative for redistribution terms. Executables are tracked by Git LFS; a clone intended for packaging must complete `git lfs pull` before the ordinary build.
