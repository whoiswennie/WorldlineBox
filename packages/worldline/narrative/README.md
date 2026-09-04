# Worldline narrative

English | [中文](README.zh.md)

This package projects authoritative Run state into text play and a replaceable StoryStage renderer without granting narration state-mutation authority.

## Contract

Opening, narration, choices, free input, rephrasing, savepoints, branching, and retry all resolve against durable Run records. Each story stage is ordered: the narrator first retains a complete structured beat, the creative state director atomically proposes schema-valid soft state, memory, and plot evidence, presentation reaches the end of that beat, and only then does the creative choice director generate exactly three distinct scene-specific plans. Those plans cover mainline progress, character depth, and meaningful deviation, but each must bind to a currently legal Runtime opportunity. They are never copied from authored plot points or filled from static labels.

Free text uses the same creative director to map the player's intent to a current legal opportunity before state can change. Runtime alone advances time and location. Retries and rephrases add records rather than rewriting history, and replay cursors prevent an already presented beat from being shown again after navigation.

## Model Experience

### Text-play narration

#### What the model sees

A bounded `SceneFrame`, recent perspective-safe beats, style settings, and the current narration task. The creative route receives separate bounded packs for schema-driven state/memory assessment and final choice generation. Custom authored state fields are projected through their schemas instead of a fixed product whitelist.

#### Token effect

Each prose or creative request is independently capped; recent beats and scene data are truncated by the package's context policy before dispatch.

#### KV Cache effect

Stable stage instructions remain prefix-stable, while scene state, recent beats, and the current user action replace the request suffix.

## Known Limitations and Deferred Work

- **Text-first core with native generation markers** — rich StoryStage renderers consume authorized scene/media cues. When an image or sound naturally belongs at a point in the passage and no asset exists, the narrator authors a `media-intent` as a first-class block at that exact position in the same ordered sequence, not as post-processing metadata. It contains an `image`/`audio` kind, a constrained purpose, a generator-ready prompt, and required fallback text. A later image/audio provider can consume that exact discriminated block; without one, the story renders the fallback inline in the same reveal order. Generation and playback remain separate extension responsibilities.
