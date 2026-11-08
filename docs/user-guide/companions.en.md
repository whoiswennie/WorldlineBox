# Companions and continuous chat

This guide covers the companion workspace rebuilt on 3 November 2026. It is a development version; model understanding and long-running behavior can still encounter problems.

## Start

Install an official DSH runtime in Launcher, then select or confirm creation of one shared execution instance. Every companion uses that instance's account, API, plugins and skills; no per-character binding or login is required. Ordinary chat runs in the application and does not require the configured DSH Host to be running. In Model settings, configure an **OpenAI Chat Completions** connection for the companion Router. DSH's Web workbench manages its native configuration. Open Companions, choose a built-in companion or create your own, and send a message. Enter sends; Shift+Enter adds a line. IME composition does not send.

Chats, memories, task ownership, Worker sessions and task directories remain separate. Disabling one companion pauses only its tasks and leaves the shared Host available to everyone else. Existing tasks retain their original instance when the shared selection changes, including tasks from older private environments; those environments are retained without merging credentials or plugins. Upgrading the shared instance preserves its identity, home, account configuration and plugins, with a snapshot and rollback on failure.

Companion data does not require an asset library. Missing model or runtime configuration produces a real error while saved messages remain readable.

## Conversations and tasks

Direct, group and world conversations stay in the same workspace. Earlier messages load by page. Replies stream into the current conversation and can be stopped. Failed sends retain their drafts; drafts and in-flight text are isolated across conversations. Users do not manage native DSH Sessions.

A brain can contact another existing member of its current conversation. Peer exchanges have a bounded hop count. Group membership or message content does not grant access to another private conversation.

Research, coding and file processing can be delegated to an independent DSH worker. The Tasks panel shows goals and states, and offers cancellation; the brain can check status or send guidance. Results return to the source conversation. Submitted does not mean completed. Stop first saves a cancellation request and waits for native confirmation; work already completed can still return its real success receipt. Confirmed cancellation cannot be restarted by a late result. Tasks originating from a user's direct chat can receive full DSH tools; group, peer and world sources remain scoped. Message text cannot expand that scope. Stopping or forgetting cannot undo external changes already made.

## Memory

Open **Memory** from the chat toolbar to enter the selected companion's **Memory workspace**. **Journal** lists notes and tags by page; select a note to read its full text. You can save a new note, edit a note, or select related notes and write an organized version. Originals are archived after the new note is confirmed available for recall. The brain can also search, inspect historical fragments, write and forget. Automatic encoding runs in the background and may make additional model calls; a finished reply does not imply its memory index is ready.

In **Try recall**, use a natural-language question with passive or semantic recall, or use exact keywords to look up original messages. Results show VCP's actual order, supplied scores and timing; missing values are not invented. Recent checks stay within the selected companion and audience and do not become new memories.

Open **Organization & dreams**. The left column contains **Plan organization**, **Dream candidates** and the task list; expand **Background schedule** only when you need its settings. The right column starts with the selected task and its content. Each column scrolls separately, so expanding settings does not displace the reading area. Floating feedback does not push content down; use task status and actual receipts to confirm completion.

Each batch examines at most 24 notes. Tasks, candidates and diagnostics are paginated; use **Continue with the next batch** when available. Finishing one batch does not mean the entire library was examined. Notes beyond the batch's capacity or awaiting confirmation remain eligible for a later visit. The page reports changed or withdrawn sources; current text is not presented as the original version used by an older plan.

Review candidates individually. Read the source notes, quotations and proposed text, then choose **Review and approve** followed by **Confirm this approval**, or **Reject candidate**. Dream narratives, associations and insights are not user facts. Unapproved candidates do not rewrite memory; a saved dream insight is explicitly labelled as not being a user fact.

Organization and **Archive redundant notes** retain the originals as read-only notes for full-text reading. Archiving removes old notes from recall; it is different from forgetting and does not withdraw independent facts from the same source. **Source changed** means you should check the source again. **Outcome unconfirmed** or **Partially completed; verify** means completion has not been confirmed. A generated plan or an approval alone does not mean the write succeeded.

Background organization is enabled by default, with a 24-hour wait before its first run and a minimum interval of 24 hours. It generates a reviewable plan only when there is new material, the current audience has been idle for at least 15 minutes, and at least 12 notes are available. New chat takes priority. Settings let you disable background work or change its mode. **Application policy** defaults to **Review every candidate**. **Auto-apply lossless organization only** can automatically combine complete original text; it does not automatically apply model rewrites. Updates, dream insights and separate archive actions still require review.

In groups, first choose the companion whose memory you want to view. Forget withdraws the note and related sources from use and isolates prior active context. Affected replies or tasks can stop, and delayed capture work cannot restore withdrawn sources.

“This memory has been withdrawn from use” does **not** mean original messages, backups or DSH cold logs were physically erased. Historical text can remain visible. Recall is selective and can miss or misinterpret facts; ask for source lookup when accuracy matters.

## World

Open World scene from a world channel. The position map and Three.js scene use the same host-owned coordinates, routes, occupancy and activities. Click the map or double-click the 3D floor to move along a valid path. Use the garden/home buttons to travel through portals and select furniture to interact. WebGL failures return to the position map.

World events go to actual co-located observers. Other companions cannot enter private homes. Known art IDs use their corresponding sheets; new companions currently show their own name markers. Physical “at the computer” does not prove a DSH task ran.

## Limits and recovery

Saved messages, events, tasks and physical state recover on restart. Uncertain delivery keeps its native event ID instead of creating another execution. The application does not invent activity while closed.

The application summarizes active context and uses VCP to look up earlier messages. Summarization can use a model and delay a reply; failure retains the prior records. Continuous conversations do not guarantee perfect recall or constant latency.

The former independent world windows, relationship/routine simulation, calendar and life-simulation growth dashboards are retired. Memory dream candidates are available as described above. QQ/WeChat, phone gateways and broader simulation remain future work. See the [runtime guide](../developer/superagent-bot-runtime-guide.md) for implementation and verification boundaries.
