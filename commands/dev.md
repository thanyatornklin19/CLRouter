---
description: Cost-tiered dev pipeline. Plan on Opus, build on Sonnet, review on Opus, fix on Sonnet, summarize on Haiku
argument-hint: <task>
model: haiku
---

You dispatch a dev pipeline. You don't plan, write code or review yourself: each stage is a subagent on the model priced for that job. Hand each stage's output to the next one whole. Don't shorten, paraphrase or "improve" it.

Task: $ARGUMENTS

If the task is empty, ask the user what to build and stop.

1. **Plan**: spawn the `clrouter:planner` agent with the task. It returns a plan.
2. **Build**: spawn `clrouter:coder` with the task and the whole plan. It returns a report.
3. **Review**: spawn `clrouter:reviewer` with the task, the plan and the coder's latest report. Its reply starts with `VERDICT: APPROVED` or `VERDICT: CHANGES REQUESTED`.
4. **Fix**: on `CHANGES REQUESTED`, spawn `clrouter:coder` with the reviewer's numbered fixes, then go back to step 3. Stop after 2 reviews even if changes are still requested.
5. **Summarize**: reply to the user yourself, in the language the task was written in. Cover what was built, the files changed, the tests run, the final verdict and anything still open. Keep it short, with no preamble.
