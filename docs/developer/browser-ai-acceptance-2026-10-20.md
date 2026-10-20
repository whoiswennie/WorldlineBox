# Native browser AI and tab controls acceptance

This change retains Electron WebContentsView tabs and their persistent browser partition. It adds a native start/results page and a resizable browser conversation, rather than inserting an assistant into untrusted web documents.

## Implementation

- Audio buttons and native tab menus target explicit IDs. Muting affects WebContents output, never instantiates a discarded page, and persists through reload, duplication, restoration and restart. Tab duplication preserves native navigation/zoom; batch closing preserves pinned tabs and avoids loading intermediate pages.
- Website-authored `about:blank` popup documents retain their actual native contents, separate from the application's start page. Navigation completion reapplies the stored page zoom; Ctrl+wheel and shortcuts update the actual setting.
- Browser-only DeepSeek credentials use safeStorage and an encrypted file outside the repository. Renderer state returns readiness/source, never plaintext. A non-DeepSeek global provider key cannot be sent to the DeepSeek tool origin. Requests use fixed official search/fetch URLs, reject redirects, limit response bytes, and observe global networking.
- The global model receives native function declarations and genuine call/result messages for Chat Completions, Responses, Anthropic, Gemini and DashScope. Search syntax is explicitly documented in the declaration. The tool set is browser-scoped and contains no generic command/JS/filesystem tool.
- DOM refs live in an isolated world. Observations exclude password/file/payment/OTP autocomplete values. Actions validate tab identity, document version, element connectivity, label, target and hit testing. Mouse coordinates account for page zoom. Form/state-changing controls request a grounded confirmation; ordinary browsing controls do not require one.
- Results and actual rendered-page reads retain stable source IDs and provenance. Search summaries do not become fetched-page claims. The model receives a bounded executed-tool audit even after large payloads are compacted; cached evidence is available through pagination.
- Native call/result groups stay intact during history compaction. Mixed Latin/CJK token estimates reserve output space. History, source bodies and tool traces have explicit caps. Cancellation aborts network/model work, ignores obsolete approvals and does not reverse completed actions. Repeated identical calls, iteration count, executed-tool count and wall time are bounded.
- The software logo replaces generic hero/header symbols. The native start page does not duplicate bookmarks beneath the search input. Search/send use named buttons; the composer expands automatically. CommonMark/GFM, math and syntax highlighting reuse installed libraries, and Mermaid is loaded on demand after streaming. SVG is sanitized; raw HTML, unsafe links, active diagram handlers and remote image loads remain inert.
- Source cards distinguish search summaries, fetched content and live browser reads. Numbered citations link to actual sources; body Markdown mounts only on explicit expansion. Human-readable tool steps keep raw JSON inside collapsed technical details. Cards and completed Markdown use memoization so streamed responses do not repeatedly parse cached bodies.
- Conversation/history, source caches, tool records and compaction extracts are memory-only. Restarting the same profile retains encrypted credentials and context preferences but starts with an empty conversation; a regression verifies that no chat/evidence files are written.

## Validation evidence

The browser unit regression covers provider adapters, exact tool syntax, URL boundaries, secret redaction, missing credentials, tools-only operation, sequential function rounds, cancellation, matching approvals, long multi-turn context compaction, tab routing and Markdown. `browser-native` additionally verifies actual native audio flags, lazy muting, restart persistence, duplicate navigation/zoom, pinned batch closure and an actual MHTML archive.

`browser-ai` exercises the production main/preload/renderer path against a local model endpoint: navigate, observe grounded refs, fill, confirm a POST-form click, change zoom before that click, read actual page content, mute, follow up, render tables/code/math/Mermaid, resize by keyboard/mouse, collapse the sidebar and unmute a background tab without selecting it. `browser-playback-resilience` checks actual H.264/AAC playback and stable viewport geometry. `browser-popups` covers opener/POST/session/background/capacity behavior.

The opt-in `scripts/verify-browser-ai-live.mjs` requires a credential supplied only through its environment. It runs real DeepSeek model/tool inference in an isolated profile. Its first phase checks model-selected official-domain/language search, real Fetch Markdown and source citations. The second phase uses the same actual model with real native page tools on a harmless local fixture and verifies the DOM result. Only specific fixture form actions may be automatically approved. Encrypted test credentials remain in the isolated temporary profile; output receipts explicitly reject plaintext credentials. The test key is not committed or included in builds.

Local evidence is written under `.tools/test-output/browser-ai/`, including `live-deepseek.json`, `start-page-light.png` and `native-chat-light.png`. Regression/build logs are under `.tools/browser-ai-*.txt`. Unit/fixture results do not constitute real-provider certification for every configurable model; the live provider used here is DeepSeek Flash.

## Sources

- [DeepSeek Search and Fetch](https://api-docs.deepseek.com/zh-cn/guides/search/)
- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents)
- [Mermaid usage and security configuration](https://mermaid.js.org/config/usage.html)
