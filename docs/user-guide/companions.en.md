# Companions and continuous chat

Companion chat uses native DSH sessions and the RiverMemo V5 integration introduced on 27 November 2026. See the [session implementation record](../developer/dsh-native-companion-refactor-2026-11-09.md) and the [memory integration notes](../../resources/vcp-memory/INTEGRATION.md).

## Start

Install an official DSH runtime in Launcher and choose one shared execution instance. Companions share its native configuration while keeping separate workspaces and topic Sessions. Chat requires the DSH Host. Configure the companion model in Model settings. Enter sends; Shift+Enter inserts a line.

Chats, memories, task ownership, Worker sessions and task directories remain separate. Disabling one companion pauses only its tasks and leaves the shared Host available to everyone else. Existing tasks retain their original instance when the shared selection changes, including tasks from older private environments; those environments are retained without merging credentials or plugins. Upgrading the shared instance preserves its identity, home, account configuration and plugins, with a snapshot and rollback on failure.

Companion data does not require an asset library. Missing model or runtime configuration produces a real error while saved messages remain readable.

## Conversations, topics and native tasks

The chat is a frontend and deterministic router. The selected companion's native DSH Session is the task's main agent; contacted companions and native subagents execute its assignments. There is no additional Router Agent or application Agent Loop.

The topic bar above the composer shows where idle follow-ups go. **New topic** creates independent context. Open the topic name to search and reconnect earlier WorldlineBox topics. **Compact** invokes the selected native Session's `/compact`; follow-ups retain that Session identity. In a group, choose which companion to compact.

The topic picker initially shows six recent topics, with pinned topics first and the rest ordered by latest activity. **All** and **Favorites** show twelve topics per page and support fuzzy search with gaps; separate multiple keywords with spaces. Each row's **…** menu offers pinning, favorites and renaming. Renaming also updates that topic's native DSH sessions; a clock marks pending synchronization. Favorites search is restricted to saved favorites.

While work is running, new input appears in the queue above the composer. It normally starts a new topic after the task finishes, or continues another explicitly selected topic. **Steer** delivers the queued message and verified attachments to the current native task at its next input boundary. Unknown deliveries retain their stable receipt; they are never silently replayed as new work. Confirmed non-admission restores the queue.

While work runs, necessary progress, question and continuation controls appear outside the reply bubble. A completed bubble contains only the last committed body, a sticker group and attachments. Intermediate bodies, sticker captions and completed execution counters are hidden. Standalone sticker exchanges remain supported. Uploads reach DSH as verified absolute paths. Native `present` deliveries become real chat attachments for preview and saving. Stopping work does not undo completed external effects.

**Stop** interrupts execution and preserves progress. Once DSH confirms the stop, **Continue execution** reconnects the original task and topic Session without typing or sending another message. Switching topics or restarting the app preserves this control. An interrupted result is not recorded as a completed diary entry. If a later message has already progressed in the same topic, continue from that latest reply instead.

In a companion chat, choose **Apps → Cabin World** to open the built-in game. While the topic is connected, each new turn, queued task, and steering message automatically reads the resident's latest location, weather, and recent activities. The companion can also take walks or use furniture when it suits the conversation. Each companion has a resident shared across their topics. Chat continues if the game closes. Select **Cabin World** again to reconnect, or remove the chip above the composer to disconnect the topic. Your game save is kept.

## Memory

Talk to the companion as usual. For example, agree on a meeting place for Saturday in one topic. Once the companion has recorded the plan, asking “Where are we meeting on Saturday?” in a fresh topic of the same chat triggers recall automatically. Each companion keeps a separate memory for each audience. Indexing and retrieval use the bundled multimodal model and require no VCP installation or memory API key. Diary writing, summaries and dreams use the chat connection already configured in Model settings.

Development profiles retire the old experimental memory once. A topic that previously sent experimental diary text to the model keeps its chat window and opens a fresh model session for subsequent messages. Your new diaries and visible conversation history persist across restarts.

Open **Memory** from the chat toolbar to enter the selected companion's **Memory workspace**. **Journal** lists notes and tags by page; select a note to read its full text. You can save a new note, edit a note, or select related notes and write an organized version. Originals are archived after the new note is confirmed available for recall. The brain can also search, inspect historical fragments, write and forget. The companion decides during conversation which experiences to record. Each diary file carries its author and tags. The workspace shows its indexing status.

**Try recall** offers three ways to search. **Passive recall** shows which diary entries VCP would bring into a turn for a single question. Ordinary chat also uses the topic history. **Semantic search** uses LightMemo to find related entries and shows the order and scores the engine supplies. **Original keywords** uses DeepMemo to show matching chat excerpts with their topic, speakers and surrounding messages. The workspace displays measured search times and keeps recent checks within the selected companion and audience. Trying a query does not write a diary entry.

Open **Organization & dreams**. The left column contains **Plan organization**, **Dream candidates** and the task list; expand **Background schedule** only when you need its settings. The right column starts with the selected task and its content. Each column scrolls separately, so expanding settings does not displace the reading area. Floating feedback does not push content down; use task status and actual receipts to confirm completion.

Dreams sample diaries across the current audience’s entire collection and follow their associations into earlier entries. Manual organization can work in batches. Use **Continue with the next batch** when available. The page identifies sources that have changed or been withdrawn.

In the Memory workspace, select **Health scan**, **Organize**, **Event tracking** or **Deep clean**. A health scan produces a read-only report. Event tracking can append a sourced status annotation to an earlier diary. Deep cleaning requires your confirmation and covers the current companion and audience. Dream proposals have a separate entry.

Ordinary diary organization follows MemoMaster. New companions have model review enabled. An independent review checks the original entries, dates, authors, quotations and reasons for archiving before applying a change. You decide uncertain cases and can turn model review off to review every candidate yourself. Dream proposals always require your approval. A saved dream insight carries an explicit label.

Organization and **Archive redundant notes** retain the originals as read-only notes for full-text reading. Archiving removes old notes from recall; it is different from forgetting and does not withdraw independent facts from the same source. **Source changed** means you should check the source again. **Outcome unconfirmed** or **Partially completed; verify** means completion has not been confirmed. A generated plan or an approval alone does not mean the write succeeded.

Daytime use is enough for automatic maintenance. Once a new or edited diary is indexed, the app records which companion and audience have work pending. The companion can start a dream after about two minutes without input, once its foreground turns have finished. Typing or sending another question gives chat priority. Pending work survives a restart or a computer sleep. Several missed nights create a single catch-up opportunity.

If a long absence puts all eligible entries outside the native dream sampling range, the companion reads the outstanding diary versions in batches and looks up related entries. The organizer groups incoming entries by their original month and finds related entries across months. New entries have a 30-day settling period before redundancy checks. Opening the app after that date gives the companion another opportunity to check them while idle. One batch merges or archives up to 20 originals. A long event can produce a Chronicle for its history and a Crystal for insights, linked by a shared event tag.

At night, AgentDream checks every 15 minutes between 01:00 and 06:00 local time. Each eligible companion has a 60% chance of dreaming on a check. Daytime and nighttime dreams share an eight-hour cooldown after success. You can turn off automatic maintenance or start a plan manually.

You can send another question while a companion is dreaming, writing a diary or building an index. If recall takes too long, the companion answers with the context already available. That turn may miss an older memory. Queued diary writes retain the text, tags and sources and can finish after a restart.

In groups, first choose the companion whose memory you want to view. Forget withdraws the note and related sources from use and isolates prior active context. Affected replies or tasks can stop. Queued diary writes check whether their sources are still available before they proceed.

“This memory has been withdrawn from use” does **not** mean original messages, backups or DSH cold logs were physically erased. Historical text can remain visible. Recall is selective and can miss or misinterpret facts; ask for source lookup when accuracy matters.

## World

Open World scene from a world channel. The position map and Three.js scene use the same host-owned coordinates, routes, occupancy and activities. Click the map or double-click the 3D floor to move along a valid path. Use the garden/home buttons to travel through portals and select furniture to interact. WebGL failures return to the position map.

World events go to actual co-located observers. Other companions cannot enter private homes. Known art IDs use their corresponding sheets; new companions currently show their own name markers. Physical “at the computer” does not prove a DSH task ran.

## Limits and recovery

Saved messages, events, tasks and physical state recover on restart. Uncertain delivery keeps its native event ID instead of creating another execution. The application does not invent activity while closed.

DSH owns context compaction; VCP provides sourced memory and history recall. Failed summarization retains prior history. Continuous conversations do not guarantee perfect recall or constant latency.

The context meter above the composer shows the selected topic's native DSH session occupancy in real time. Switching topics switches to their independent readings. In groups, select a companion to inspect its own session. A new topic displays “Pending” until native statistics are available. It never borrows the previous topic's usage.

Open the meter for current usage and model capacity, estimated system/tool/message composition, latest request input and collapsible cumulative session usage. You can compact the session or start a new topic there. The readings use DSH's native projections; cumulative usage and estimated composition are separate from current occupancy. Disconnected readings are labelled as saved statistics and refresh after reconnection, conversation changes or compaction.

The former independent world windows, relationship/routine simulation, calendar and life-simulation growth dashboards are retired. Memory dream candidates are available as described above. QQ/WeChat, phone gateways and broader simulation remain future work. See the [runtime guide](../developer/superagent-bot-runtime-guide.md) for implementation and verification boundaries.
