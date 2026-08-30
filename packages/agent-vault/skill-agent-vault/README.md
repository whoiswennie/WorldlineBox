# @deepseek-ai/dsh-skill-agent-vault

English | [中文](README.zh.md)

Eight progressively loaded methodology skills teach Agents to orient, capture immediate short memory, consolidate bounded batches, govern long memory, recall at two speeds, develop a stable structured self, learn and test capabilities, and use resources naturally. The provider contains no model call and no embedding dependency.

## Model Experience

### Progressive Vault methodology

#### What the model sees

The skill catalog exposes eight stable `SKILL.md` summaries. Selecting one loads its complete workflow body for orientation, capture, consolidation, recall, self-development, capability learning, or resource use.

#### Token effect

Discovery has a fixed eight-summary cost; one complete, data-independent workflow body is added only when selected.

#### KV Cache effect

The stable catalog preserves the reusable prefix. Selecting a different workflow changes only the later loaded-skill suffix.

## Known Limitations and Deferred Work

- Domain-specific professional curricula remain Agent-owned procedure cards rather than platform skills.
