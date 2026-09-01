# Worldline narrative

English | [中文](README.zh.md)

This package projects authoritative Run state into text play and a replaceable StoryStage renderer without granting narration state-mutation authority.

## Contract

Opening, narration, choices, free input, rephrasing, savepoints, branching, and retry all resolve against durable Run records. Free text must map to a validated action before state changes; retries and rephrases add narrative records rather than rewriting history.

## Model Experience

### Text-play narration

#### What the model sees

A bounded `SceneFrame`, recent narrative beats, visible choices, style settings, and the current narration or free-input task.

#### Token effect

Each narration request is independently capped; recent beats and scene data are truncated by the package's context policy before dispatch.

#### KV Cache effect

Stable narration instructions remain prefix-stable, while scene state, recent beats, and the current user action replace the request suffix.

## Known Limitations and Deferred Work

- **Text-first core** — rich StoryStage renderers consume structured scene and media cues, but asset generation and audiovisual playback remain separate extension responsibilities.
