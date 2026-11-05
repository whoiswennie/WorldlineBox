# Companion call assets

`live2dcubismcore.min.js` is Live2D Cubism Core, copyright Live2D Inc. Its original license header is retained. It is obtained from the official runtime URL used by the user's SDK reference: https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js . The original license applies: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html .

`scenes/evening.png` was generated with the built-in image generation tool for this project. Its prompt and usage are recorded in docs/developer/companion-call-implementation-2026-11-05.md.

`deepseek/` and `ringtone.wav` are user-provided runtime source assets retained in version control. The model's MOC3 and PNG textures use Git LFS; its model JSON, original notice and creator credits remain ordinary Git files in `deepseek/MODEL-LICENSE.txt` and `catalog.json`. Run `git lfs pull` after cloning to materialize the model binaries before development or packaging. `scripts/stage-companion-call.mjs` can reconstruct these runtime files from the original local model archive and ringtone. Original download archives and PSD files are not runtime dependencies and are not staged.
