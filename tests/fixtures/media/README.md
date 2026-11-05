# Speech acceptance audio

`xiaoyi-neutral.mp3` is a fixed, non-personal test utterance generated through Microsoft Edge Read Aloud with `zh-CN-XiaoyiNeural` on 2026-11-05, using the project's actual Edge transport.

Text: 你好，我是晓伊。今天也很高兴见到你，我们慢慢聊。

Format: 24 kHz, 48 kbit/s, mono MP3. Size: 32,976 bytes. SHA-256: `a21dcc7c4cf62e9f4720b56dbc4bd7dcacbb058b5439add852566604df2a7074`.

The Electron speech test substitutes this file only for `node-edge-tts.streamAudio` to avoid network variability or live chat transmission. It still exercises actual Main IPC authorization, the application speech service and cache, MP3 decoding, AudioContext analysis, the display-only SoulLink runtime, Live2D rendering and cleanup. The file is not a fixture for model-generated chat quality or a substitute for the separate live TTS connectivity check.
