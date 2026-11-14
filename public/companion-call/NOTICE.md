# Companion call assets

`live2dcubismcore.min.js` is Live2D Cubism Core, copyright Live2D Inc. Its original license header is retained. It is obtained from the official runtime URL used by the user's SDK reference: https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js . The original license applies: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html .

`scenes/evening.png` was generated with the built-in image generation tool for this project. Its prompt and usage are recorded in docs/developer/companion-call-implementation-2026-11-05.md.

`deepseek/` is an optional local-only model directory. Obtain DeepSeek-chan and follow the original terms. Art and layer separation by 神宫凉子, Live2D rigging by 霓虹猫_NeonNeko. `node scripts/stage-companion-call.mjs --model <author ZIP>` prepares the files for local use. For a private Windows installer, set `WORLDLINEBOX_INCLUDE_PRIVATE_CALL_ASSETS=1` before building. Public builds use the character portrait fallback. [Author's announcement](https://www.bilibili.com/video/BV1ALnw6YEGK)

`ringtone.wav` and `ringtones/dafeiyu.ogg` are synthesized notification tones generated for WorldlineBox. 大肥鱼 uses its own tone.
