# Companion call assets

`live2dcubismcore.min.js` is Live2D Cubism Core, copyright Live2D Inc. Its original license header is retained. It is obtained from the official runtime URL used by the user's SDK reference: https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js . The original license applies: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html .

`scenes/evening.png` was generated with the built-in image generation tool for this project. Its prompt and usage are recorded in docs/developer/companion-call-implementation-2026-11-05.md.

`deepseek/` is an optional local-only model directory. Obtain DeepSeek-chan and follow the original terms. Art and layer separation by 神宫凉子, Live2D rigging by 霓虹猫_NeonNeko. In the public desktop app, open 大肥鱼's character card, select Appearance and performance, and import the original ZIP under Live2D. The app stores the files in its local user data. [Author's release](https://www.bilibili.com/video/BV1KmxY66EZ3)

`ringtone.wav` is the common tone, including for 菲比啾比. The desktop app uses `ringtones/dafeiyu.wav` for 大肥鱼. These WAV tones and the mobile `ringtones/dafeiyu.ogg` are synthesized for WorldlineBox.

For a private Windows build using files you already obtained, stage the author ZIP and the two audio sources with `node scripts/stage-companion-call.mjs --model <ZIP> --ringtone <common audio> --dafeiyu-ringtone <dedicated audio>`. Set `WORLDLINEBOX_INCLUDE_PRIVATE_CALL_ASSETS=1` for packaging. The installer includes the staged model and the full audio tracks. Playback stops when ringing ends. Original model and audio terms still apply. [DeepSeek-chan](https://www.bilibili.com/video/BV1KmxY66EZ3) · [Let Me Go animation PV](https://www.bilibili.com/video/BV1hofgBcE8W) · [菲比 ringtone source](https://www.bilibili.com/video/BV14tg562Egw)
