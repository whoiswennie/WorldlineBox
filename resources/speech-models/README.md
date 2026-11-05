# Local CPU speech assets

WorldlineBox uses SenseVoiceSmall INT8 ONNX, sherpa-onnx-node 1.13.8 and Silero VAD. This is a separate speech recognition service; it does not load weights into the embedding runtime or use a GPU.

The 241,357,257 bytes of pinned assets in `manifest.json` are versioned source resources: ONNX weights use Git LFS; the vocabulary, manifest and licenses use ordinary Git. Run `git lfs pull` after cloning to materialize the weights. `node scripts/stage-local-speech.mjs` verifies existing resources and can acquire missing or invalid pinned assets on the build machine. Forge runs this preparation before packaging and copies this directory and `speech-runtime/` outside ASAR. `node scripts/stage-local-speech.mjs --verify` verifies the staged resources without network access. Package verification repeats the size and SHA-256 checks on the actual packaged directory and checks the shipped worker and license files.

The application uses bundled assets after a streamed integrity check. If development assets are absent, the explicit preparation action downloads the same pinned files into user data, verifies each file before publishing it, and retains complete verified files for retries. Inference is local; preparation may use Hugging Face or HF-Mirror. The model name, source attribution and model license are retained in this directory.

The official Chinese test recording, `test_wavs/zh.wav` from the same pinned model repository, is versioned as `tests/fixtures/media/sensevoice-zh.wav`. The native speech acceptance tests use this fixture without a separate download; the application does not ship or need it.
