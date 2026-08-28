# plan/ — plan collaboration state

English | [中文](README.zh.md)

Plan mode is logged, per-agent collaboration state rather than a generic mode registry or capability seam.

| Package | Role | ctx key |
|---|---|---|
| [`plan-mode/`](plan-mode/README.md) | Owns plan-mode state, guidance, commands, and review flow | `ctx.planMode` |

The plan-specific collaboration state decision records the family design.

The subsystem reference — the `plan/mode` fold, the step-boundary flush, configuration, the exit tool — is [docs/subsystems/plan.md](../../docs/subsystems/plan.md); design in plan-specific collaboration state.
