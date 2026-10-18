# EmbeddingGemma 2 runtime pin

The phase-one local GGUF experiment targets the official `llama.cpp` Windows CUDA 12.4 x64 release `b11457`, commit `5ad1c5da0ad7f6176256b823925aad19134f0263`. This pinned build passed real image-input canaries with the Q4, Q8, and BF16 profiles on CPU; do not substitute an unpinned server when comparing quantizations.

The runtime starts in embedding mode with mean pooling, one model at a time, a 4096-token context, and a loopback-only HTTP listener. The experiment runner waits for `GET /health` before sending requests. CPU is the default; `--gpu-layers N` opts into GPU offload.

Image requests use `POST /v1/embeddings` with typed content nested inside an input item:

```json
{
  "model": "embeddinggemma-2",
  "input": [
    {
      "content": [
        {
          "type": "image_url",
          "image_url": { "url": "data:image/png;base64,..." }
        }
      ]
    }
  ]
}
```

The model returns the vector at `data[0].embedding`. Text queries use `task: search result | query: {query}`. The server's legacy `/embedding` `image_data` field silently ignores images, so the experiment does not use it.

Each quantization profile must pass the experiment's generated-image canary before its corpus or query results are accepted. The canary checks red, blue, and checkerboard images, a repeated identical image, and a text-only control. Audio and video remain unverified by this image-only runtime smoke.

## Runtime smoke evidence

On 2026-10-10, the standalone experiment completed on the pinned Windows build with `--gpu-layers 0`, a two-image generated corpus (red square and checkerboard), an external generated blue-square query image, and two corresponding text queries. The Q4 and Q8 profiles each loaded successfully, returned valid 768-dimensional vectors for image and text requests, passed the canary, and encoded both corpus images without skips. The text-query Top-1 results matched the generated red/checkerboard examples. The blue query image also returned ranked results against the two-image corpus; this tiny synthetic set does not measure general retrieval quality.

| Profile | Core SHA-256 | Projector SHA-256 | Startup | Canary deltas (red/blue, red/checker, blue/checker, image/text) | Repeat cosine |
| --- | --- | --- | ---: | --- | ---: |
| Q4_K_XL | `ea905fd08e8061db77a0031cbb5096d459d7cfd2bdd0ad2ba66e483f16719493` | `90e7b0238009e2954f856f2081dcf7f35af026b64c765e98f4777053e1754460` | 2059 ms | 0.08314 / 0.07895 / 0.08891 / 0.13186 | 1.0 |
| Q8_0 | `6f1bd4ac6c5df7444f9cca7ca36cafe6cfa34cd6f49fefb1e0b4be8143aed8bc` | `90e7b0238009e2954f856f2081dcf7f35af026b64c765e98f4777053e1754460` | 2061 ms | 0.08491 / 0.08225 / 0.08838 / 0.13863 | 1.0 |
| BF16 | `f315cbbb30dd487e44d501c8902abe88808755e43753a96beed1964f0a48aa4f` | `995aaa56e88b9b631f651861d659b728a625ccc02a238be37cff56cf11dc0032` | 2565 ms | 0.08366 / 0.08147 / 0.08817 / 0.13877 | 1.0 |

After the individual runs, a default sequential run loaded Q4, Q8, then BF16 in one experiment process. The overall report and all three profile statuses were `completed`; every canary passed, both sample images were encoded per profile, and no image was skipped. Audio and video remain unverified.

The image request correction was confirmed in the upstream issue discussion: [llama.cpp #30082](https://github.com/ggml-org/llama.cpp/issues/30082). The model architecture support was merged in [llama.cpp #30054](https://github.com/ggml-org/llama.cpp/pull/30054). Model files are pinned separately to Unsloth revision `412430755667d84b1ac64fe1fe2693aa6219f1d9`.
