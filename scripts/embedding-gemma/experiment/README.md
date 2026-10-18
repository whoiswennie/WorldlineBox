# EmbeddingGemma 2 image-search experiment

This is a small, standalone comparison tool for the three existing Unsloth GGUF profiles. It does not open a WorldlineBox library, write a database, or download model files. It launches one local `llama-server` at a time and stops it before loading the next profile.

## Prepare the files

Use the fixed [Hugging Face revision](https://huggingface.co/unsloth/embeddinggemma-2-GGUF/tree/412430755667d84b1ac64fe1fe2693aa6219f1d9) `412430755667d84b1ac64fe1fe2693aa6219f1d9` and place the following files in a model-cache folder outside the repository. Keep this directory separate from the selected image-sample folder:

| Profile | Core model | Projector |
| --- | --- | --- |
| Q4 | `embeddinggemma-2-UD-Q4_K_XL.gguf` | `mmproj-Q8_0.gguf` |
| Q8 | `embeddinggemma-2-Q8_0.gguf` | `mmproj-Q8_0.gguf` |
| BF16 | `embeddinggemma-2-BF16.gguf` | `mmproj-BF16.gguf` |

Q4 and Q8 share the Q8 projector. Download the files yourself from the linked revision; the script never downloads weights. It records SHA-256 for each selected file. Do not place model weights or user media in this repository.

Install/build the pinned `llama-server` b11457 runtime (commit `5ad1c5da0ad7f6176256b823925aad19134f0263`), which supports EmbeddingGemma 2's GGUF architecture and the corrected nested image request shape. The report records the full runtime commit when the executable reports it; for this pinned build the harness recognizes its build number and short commit. This experiment sends images as `input → content → image_url` data URLs to `POST /v1/embeddings`; it has no text-only fallback for image inputs.

## Run on Windows PowerShell

Choose a folder containing 2–100 JPG, PNG, or WebP files directly inside it. A 20–100 image set is recommended for comparing retrieval quality. This first version does not scan subfolders. The optional query image must be outside the sample folder. Each image request is limited to 64 MiB.

```powershell
$images = Read-Host 'Path to the selected 2-100 image sample folder'
$models = Read-Host 'Path to the local GGUF model-cache folder'
$output = Read-Host 'Path to an existing output folder outside the repository'
$runtime = Read-Host 'Path to the llama-server executable'

node scripts/embedding-gemma/experiment/run.mjs `
  --images $images `
  --models $models `
  --output $output `
  --runtime $runtime `
  --text 'a red car in the snow' `
  --text '雪地里的红色汽车'
```

For image-to-image only, run the same command with `--query-image $queryImage` instead of the `--text` arguments, where `$queryImage` is a non-empty path outside the sample folder. PowerShell's empty `Read-Host` result is not a valid path. Repeat `--text` for each text query; at least one text query or one query image is required. By default all three profiles run in Q4, Q8, BF16 order. To run one profile, add `--profile Q4_K_XL`, `--profile Q8_0`, or `--profile BF16`. Text search uses `task: search result | query: ...`; images have no text prefix. CPU inference is the default; `--gpu-layers N` opts into GPU offload.

The script first generates its own red, blue, and checkerboard PNG inputs. It checks that each profile returns 768 finite nonzero values, that different image contents produce different vectors, and that the same image gives a repeatable vector. It also compares an image vector with a text-only control. A failed or unavailable image path stops that profile; it never reports text vectors as image results.

## Results and limits

The run creates an app-owned folder named `worldlinebox-embedding-gemma` below the selected output folder and writes `report.json`, `report.html`, and `sample-map.json` there. Open `report.html` in a browser, then choose the original sample folder and the matching `sample-map.json` to show side-by-side profile rankings with clickable thumbnails. The page loads those selected files into the browser tab only; it does not send them over the network or copy source images. Image names in `report.json` and `report.html` are replaced by IDs; `sample-map.json` locally maps those IDs to the selected filenames and text queries and is marked as private user data. The live CLI output also shows the selected filenames while the run is active. The report includes per-profile file hashes, runtime commit when available, startup and encoding times, cosine-ranked Top-K results, skips and errors, and image-canary measurements. Peak memory is reported as unavailable in this first CLI version.

This stage tests static-image text-to-image and image-to-image retrieval only. It does not test audio, video, model quality beyond your chosen small sample, GPU memory, or production indexing. A runtime that does not answer the nested image request correctly, returns an invalid vector, or fails the image canary cannot produce results for that profile; the next quantization profile is still attempted. Profiles with skipped images are marked `partial` and report their skipped count; if any profile fails, the overall report is `incomplete`.
