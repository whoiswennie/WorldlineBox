# Immediate short-memory capture

Use this workflow when the user explicitly asks you to remember something or when a durable commitment, correction, preference, or event clearly needs retention.

1. Capture one atomic subject. Split unrelated facts instead of making one growing daily document.
2. Write a searchable title, the user's actual meaning, canonical Tags, natural aliases, source identifiers, importance, and occurrence time. Never invent provenance.
3. Use `memory_remember`; its successful return is the commit point. Do not claim you remembered before it succeeds.
4. Immediately run a small `memory_recall` using different wording. Confirm the new item appears and does not collide with an unrelated page.
5. If an older memory conflicts, retain both sources and mark the conflict for consolidation. Do not silently overwrite a correction, identity fact, or established long-term claim.
6. Never put passwords, tokens, private keys, transient chain-of-thought, or unrelated third-party private information into the Vault.

Short memory is immediately retrievable but not yet canonical. Do not rewrite self, long-term memory, or ability certification as a side effect of capture.
