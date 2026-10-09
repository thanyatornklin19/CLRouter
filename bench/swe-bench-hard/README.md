# Benchmark: hard SWE-bench Verified tasks

Real bug reports from real repositories, graded by the official SWE-bench harness. The [polyglot pilot](../aider-polyglot) hit the ceiling: with one round of test feedback all three models solved 29 or 30 of 30 exercises, so it couldn't say where Opus earns its price. This benchmark is built to answer that question. It governs claims C6 and C7 in [`../PROTOCOL.md`](../PROTOCOL.md).

**Status: harness built and checked; pool, arms and pass rules fixed. The pilot starts after this commit.**

## The tasks

[SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) is 500 GitHub issues from 12 Python projects. Each comes with the fix the maintainers merged and the tests that came with it. Human annotators screened every task for a clear issue and fair tests.

The rule, fixed in [`pick.py`](pick.py) before any model ran:

- **Django and SymPy only** (306 of the 500).
- **Hard:** resolved by at least 1 and at most 5 of the 35 leaderboard submissions recorded for every task (October 2023 to October 2024). At least one means the task can be solved from its issue; at most five means most systems failed it. **71 tasks** (53 Django, 18 SymPy), listed in [`pool.json`](pool.json).
- **Order:** a seeded random permutation of the 71. A run stops starting tasks when its budget runs out, so the tasks run are a random sample of the pool.

The router's call on every one of the 71 issue texts, from [`route.mjs`](route.mjs): **Sonnet at medium effort for 69**, high confidence, as build work. One goes to Haiku as a question, one is low confidence. So this benchmark tests the router's main bet head on.

**Arms:** each model at the effort the router gives it for this work. Haiku at high, Sonnet at medium, Opus at high (the router's setting for deep work, which is where it would send Opus).

## What the harness does

[`run.py`](run.py), per task:

1. Pulls the official SWE-bench image for the task.
2. Checks the image. Its repository must sit at the task's base commit (the 2026 rebuilds add one empty marker commit on top; that is accepted only when its tree is the base commit's tree). No later commit may be in the repository, reachable or not: agents have been caught reading the fix from `git log --all`.
3. Grades the reference fix with the official harness, and a do-nothing patch. The task runs only if the first passes and the second fails.
4. Runs each arm in turn, never two arms of one task at once. A fresh copy of the repository, a container from the image with **no network** and that copy mounted, and Claude Code in the copy. `python`, `pytest`, `pip` and `timeout` are shims that run inside the container, so the model tests in the exact environment the grader uses, and whatever it runs that way has no network.
5. Takes the model's patch (`git diff` of everything it changed) and grades it with the official harness, unchanged: the hidden tests go in over the patch, and every FAIL_TO_PASS and PASS_TO_PASS test must pass.

**The agent is restricted.** Its tools are Bash, Read, Edit, Write, Glob and Grep, with no MCP servers and no web tools. It may edit only inside its folder. Shell commands outside a fixed list (`ALLOWED_BASH`: Python, the test runners, read-only commands, read-only git) are refused, and the refusals are counted per run. Anything it runs through `python` runs in the network-less container, which sees only its folder.

**The prompt** is Anthropic's published SWE-bench prompt, from the Claude 3.5 Sonnet write-up, plus one paragraph saying the environment is installed and there is no network. It is in `run.py` as `PROMPT`.

```
git clone --depth 1 https://github.com/aorwall/moatless-tools SRC
python3 bench/swe-bench-hard/pick.py --src SRC/moatless/evaluation/swebench_verified_all_evaluations.json --store STORE
rm -rf SRC                                    # it holds the answers
uv venv --python 3.11 VENV && VIRTUAL_ENV=VENV uv pip install swebench==4.1.0
python3 bench/swe-bench-hard/run.py --store STORE --out OUT --harness-python VENV/bin/python --max-total 50
```

Needs Docker. Run it with `--out` outside this repository.

## What was checked on the harness

- **The grader can tell a fix from no fix.** On every task run, the reference fix must resolve and a patch that only adds an unrelated file must not; `gold.jsonl` records both per task. On the first two tasks: Django 11490 passed 1/1 FAIL_TO_PASS and 23/23 PASS_TO_PASS tests, SymPy 13877 passed 1/1 and 110/110, and the do-nothing patch failed both.
- **No future commit in the image.** The images' repositories hold exactly the history up to the base commit, plus the empty marker commit: no other refs, no unreachable commits (`git fsck`). Each task's record says so.
- **The model works in the grader's environment.** In the smoke run, `python` in the agent's shell reported Python 3.6.13 from the image's conda environment and imported Django from the agent's own folder, and Django's test runner ran there.
- **The sandbox holds.** In a probe, `curl https://github.com` was refused by the permission rules before it ran, and the agent's tool list was exactly Bash, Edit, Glob, Grep, Read and Write.
- **The effort flag is what sets effort.** `CLAUDE_EFFORT`, which the host session sets to its own level, is an output: Claude Code exports the active level to its shells. `--effort` on each run governs.
- **The dataset copy matches the images.** On every task run, the copy's base commit must be the image's commit (or its marker commit's parent), and the copy's reference fix must pass the copy's tests in the official image.

## Limits

- **The dataset is a copy.** Hugging Face, the usual source, is blocked where this was built, so the tasks come from [aorwall/moatless-tools](https://github.com/aorwall/moatless-tools) (commit and SHA-256 in [`pool.json`](pool.json)). Two checks tie it to the real thing: every image's repository sits on the copy's base commit, and the copy's reference fix passes the copy's tests in the official image. The issue texts can't be checked that way.
- **Public tasks, likely seen in training.** SWE-bench has been public since October 2023 and Verified since August 2024, and the fixes are in the projects' public history. Bigger models may remember more, and that would favour Opus. Fresh tasks, from after the models' training cutoff, are the fix; they aren't here yet.
- **"Hard" means hard for 2023 and 2024 systems.** It is the best third-party difficulty signal available offline. OpenAI's own difficulty labels are on a host this environment can't reach.
- **Two repositories.** Django and SymPy are 61% of Verified, but the other ten projects are left out.
- **Not a leaderboard number.** The agent, its prompt and its sandbox are ours, and the restricted shell may cost a model turns. The grade is the official one. Compare arms with each other, not with published scores.
- **One attempt.** SWE-bench's own measure. The agent can run the project's tests while it works; the hidden tests are never shown.
