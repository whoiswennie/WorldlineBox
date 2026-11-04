# Bundled local EmbeddingGemma 2

The default local encoder is copied from WorldlineBox's real embedded pipeline. This package contains its own weights, CPU/Vulkan llama.cpp runtimes and media executables in `vendor/local-embedding`; inference does not require WorldlineBox to remain installed and never calls a remote embedding provider.

The preserved source is `upstream/worldline/src/main/embedding-llama-session.ts` and `embedding-process-owner.ts`. CommonJS outputs are generated with pinned TypeScript 5.9.3, without algorithm changes. The original owner uses a Windows Job so closing the ownership pipe, including parent-process termination, reaps its own llama runtime. MIT attribution and the original third-party notices are included.

- Model: `google/embeddinggemma-2`, Unsloth GGUF revision `412430755667d84b1ac64fe1fe2693aa6219f1d9`.
- Core: `embeddinggemma-2-UD-Q4_K_XL.gguf`, 175,673,856 bytes, SHA-256 `ea905fd08e8061db77a0031cbb5096d459d7cfd2bdd0ad2ba66e483f16719493`.
- Projector: `mmproj-Q8_0.gguf`, 554,821,120 bytes, SHA-256 `90e7b0238009e2954f856f2081dcf7f35af026b64c765e98f4777053e1754460`.
- Encoder: llama.cpp b11457, mean pooling, 8,192-token context, 768-dimensional normalized vectors.
- Document prefix: `title: none | text: `; query prefix: `task: search result | query: `.

`startLocalEmbedding(config)` in `lib/local-embedding.cjs` returns independent `documentUrl` and `queryUrl` bases, a random session token, model/dimension/signature, direct text/image/audio/video methods and `close()`. Add `/v1/embeddings` to either base for OpenAI-format HTTP. The task prefix is chosen by the endpoint, not inferred from user text. Longer texts are split using the actual encoder tokenizer and normalized mean pooling. The gateway binds only to loopback and requires its session token.

`backend: 'auto'` tries the bundled Vulkan runtime and falls back to CPU. `backend: 'cpu'` gives reproducible CPU validation; `LOCAL_EMBEDDING_BACKEND` config is also accepted. `bundleDirectory` or `LOCAL_EMBEDDING_BUNDLE` can select another explicitly installed compatible bundle. Current shipped executables are Windows x64; another operating system needs its matching pinned llama.cpp build. Weight filenames alone do not establish a compatible runtime.

The core, projector, runtimes, FFmpeg and source hashes are recorded in `upstream/manifest-worldline.json`. Verify without the original project:

```powershell
node scripts/snapshot-local-embedding.cjs --verify
node --test tests/local-embedding.integration.test.cjs
```

`snapshot-local-embedding.cjs --source <WorldlineBox>` rebuilds the extraction from an explicit source checkout, checks the original model/runtime manifest, preserves source and notices, and regenerates outputs. Runtime use only requires the copied package, not this extraction step or TypeScript.

Real CPU validation on 2026-11-02 produced unit-length 768D vectors, with a Chinese cat query scoring 0.82384 against its cat document and 0.57949 against an unrelated database document. The integration test additionally consumes generated red/blue PNG content, tests cross-modal text-to-image retrieval, checks token rejection and queries through the actual HTTP gateway.

`node scripts/probe-local-modalities.cjs` additionally passed actual typed audio/video inference using the copied runtime. A generated two-second, mono 16 kHz PCM tone returned a finite unit-length 768D vector. Two real MP4s generated with the bundled FFmpeg, containing red and blue frames, returned vectors with cosine 0.950503, so different video content reached the encoder. The model owner closed successfully. Evidence is in `reports/local-modalities-smoke.json`; no fake vectors were involved. This establishes interface execution and a video-content canary, not speech understanding, long-video coverage or general media retrieval quality. `capabilities` reports available interfaces, not measured accuracy.

The norm and cosine values above are **test assertions only**. They do not enter production VCP retrieval scores, ranking, telemetry score fields or CLI memory results. Production ranking remains owned by the preserved VCP engine; diagnostic score output must copy the original returned fields without recomputation or a new aggregate.
