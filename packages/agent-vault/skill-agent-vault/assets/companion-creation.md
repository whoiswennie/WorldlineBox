# Virtual companion creation

Use this workflow only when the user explicitly asks to create a new virtual companion. A companion is
not just a profile row: it owns an independent, portable Agent Vault and can later join rooms with other
companions.

1. Establish the requested identity before creating anything. At minimum, determine the name, a rich
   human-readable identity title (not merely a lowercase slug), short status, profile description, core identity, personality, speaking style, and behavior
   boundaries. Ask a concise question when a missing choice would materially change the character. Do
   not present invented franchise canon, biography, relationships, or abilities as user-provided facts.
2. Call `create_virtual_companion` exactly once with the agreed profile. Put the display-ready identity
   title in `handle`, for example `NAHIDA · 须弥智慧之神 / 小吉祥草王`, never just `nahida`. Omit `avatar`
   and `portrait` when the user supplied no usable image; the Host will randomly choose Huan's bundled
   light or dark form with equal probability and persist that choice. Set `appearance_variant` only when
   the user explicitly requests one form. Never invent a local path, data URI, or remote image URL.
3. Treat the tool's successful return as the commit point. It atomically registers the companion in the
   directory and creates that companion's own `self/`, `memory/`, `procedures/`, `resources/`, `skills/`,
   policy, manifest, maps, history, and runtime-support directories. Do not create a second Vault or copy
   another companion's private knowledge.
4. Report the returned companion id and that the independent Vault is ready. Explain that the companion
   is now available in the partner list and can be invited into a room with other partners. Do not add it
   to a current room, seed relationships, or copy memories unless the user separately asks for that.
5. For later edits, update the corresponding `self/*.md` source through the dedicated Vault workflow.
   Directory cards and runtime prompts are projections of those Markdown files, never a second source of
   truth.

If creation fails, report the real error and stop. Do not retry with a different name or silently create a
partial substitute.
