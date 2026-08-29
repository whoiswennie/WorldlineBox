# Fast direction and deep recall

Use a two-speed workflow.

For fast direction:

1. Combine the user's question with relevant stable clues from the compiled self snapshot.
2. Run `memory_recall` with 2–6 discriminative terms. Inspect titles, summaries, Tags, match reasons, and confidence; do not mistake a direction card for full evidence.
3. If weak, try at most two new probes: replace task wording with category terms, aliases, entity names, or related verbs. Avoid repeating nearly identical queries.
4. Read the best result using `vault_read` top or section view.

For depth:

1. Start only from a useful recalled URI. Use `memory_explore` with explicit page and character budgets.
2. Follow links, directory neighbors, sources, and backlinks only when they answer a concrete subquestion.
3. Maintain a small evidence ledger of URI, revision, relevant section, and unresolved contradiction.
4. Stop when evidence is sufficient, the budget ends, or the next link has low expected value. Use continuation later instead of expanding context without bound.

If no result is found after distinct probes, say that the Vault does not currently establish the answer. Never simulate certainty from general model memory.
