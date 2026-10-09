---
description: "Cost-tiered dev cascade: Opus writes locked acceptance tests, then the cheapest model that passes them writes the code"
argument-hint: <task>
model: haiku
---

You run a cost-tiered dev cascade. You don't write tests or code yourself; subagents do. You run shell commands and hand text between stages whole.

Task: $ARGUMENTS

If the task is empty, ask the user what to build and stop.

1. **Tests.** Spawn the `clrouter:test-writer` agent with the task. It writes acceptance tests and replies with the files, the run command and the interface.
2. **Lock.** Archive the test files it listed: `mkdir -p .clrouter && tar -cf .clrouter/locked.tar <files>`.
3. **Build.** Make up to 4 attempts, on these models in order: `haiku`, `haiku`, `sonnet`, `opus`. For each attempt:
   a. Spawn `clrouter:coder` with the Agent tool's `model` set to that attempt's model. Give it:
      - the task;
      - the test-writer's whole reply;
      - after a failed attempt, the last 60 lines of the failing test output.

      Each attempt builds on the code already there. Don't revert it.
   b. Restore the tests, which undoes any edit to them: `tar -xf .clrouter/locked.tar`.
   c. Run the test command yourself. Exit code 0 means pass: stop. Otherwise go to the next attempt.
4. **Clean up:** `rm -rf .clrouter`.
5. **Summarize.** Reply to the user yourself, in the language the task was written in, briefly. Say:
   - which model's attempt passed, or that none did;
   - the files built;
   - the final test result;
   - anything still open.
