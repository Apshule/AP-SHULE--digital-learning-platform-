---
name: GitHub REST commit reconstruction
description: Preserve local commit identity when recreating commits through GitHub's Git Database API.
---

When recreating a local Git commit through the GitHub Git Database API, account for newline normalization in captured shell output. The `shellExec` result from `git cat-file` may omit the object's final LF in the commit message; passing that truncated text creates a sibling commit SHA even when the tree, parent, author, committer, and date match.

**Why:** A source backup produced the same tree and parent but a different commit SHA. Comparing the objects showed that the terminal newline had been lost while extracting the message.

**How to apply:** Reconstruct the exact commit message, including its final LF, before calling the create-commit endpoint. Verify the returned SHA before advancing a branch; otherwise compare the object fields and only perform a non-forced fast-forward when the intended tree and parent are confirmed.