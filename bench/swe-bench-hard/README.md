# Benchmark: hard SWE-bench Verified tasks

Real bug reports from real repositories, graded by the official SWE-bench harness. The [polyglot pilot](../aider-polyglot) hit the ceiling: with one round of test feedback all three models solved 29 or 30 of 30 exercises, so it couldn't say where Opus earns its price. This benchmark is built to answer that question. It governs claims C6 and C7 in [`../PROTOCOL.md`](../PROTOCOL.md).

**Status: harness built and checked. One pilot, stopped early (below). It supports no claim, and it shows that public SWE-bench can't answer the question this benchmark was built for.**

## The pilot, 2026-10-09

The first 9 tasks of the seeded order, one run per arm, Claude Code 2.1.295, harness commit `98b3777` (pushed before the first model run). One task, `django__django-13033`, was excluded before any model ran: its image's repository was not at the task's base commit. The run was stopped after these tasks on the maintainer's request, a stop set by time, not results. Full rows, the grader's records and every model patch: [`results/pilot-2026-10-09`](results/pilot-2026-10-09).

| Task | Haiku, high | Sonnet, medium | Opus, high |
| --- | --- | --- | --- |
| django 11490 | ✅ $0.02 | ✅ $0.11 | ✅ $0.22 |
| sympy 13877 | ✅ $0.06 | ✅ $0.10 | ✅ $0.50 |
| django 11555 | ✅ $0.02 | ✅ $0.05 | ✅ $0.35 |
| django 11299 | ✅ $0.01 | ✅ $0.05 | ✅ $0.19 |
| django 16315 | ✅ $0.03 | ✅ $0.08 | ✅ $0.43 |
| django 11265 | ✅ $0.03 | ❌ $0.07 | ✅ $0.33 |
| sympy 19040 | ✅ $0.08 | ✅ $0.27 | ✅ $0.32 |
| sympy 13615 | ✅ $0.04 | ✅ $0.09 | ✅ $0.29 |
| **Resolved** | **8/8** (68 to 100%) | **7/8** (53 to 98%) | **8/8** (68 to 100%) |
| **Cost per task** | **$0.04** | **$0.10** | **$0.33** |

Intervals are 95% Wilson. Spend: $3.73, plus a few cents for two runs discarded at the stop and a $0.02 smoke run. Every run's audit was clean: nothing touched or seen outside its own folder, no network commands.

The router sent all 8 issues to Sonnet at medium, so from any session it would have resolved 7 of 8 at $0.10 a task.

### Why these numbers don't answer the question

**These tasks were hard in 2024; they aren't now.** Each was resolved by at most 5 of 35 systems from 2023 and 2024. Here the cheapest model resolved all 8, often in two or three minutes. That is the same ceiling the polyglot pilot hit, one level up.

**And the models remember the fixes.** On `django 11265`, Haiku's and Opus's patches are both the maintainers' fix line for line, including a five-line comment. Tests can't make two models word a comment the same way. Neither run read anything outside its folder (the audit, and Opus's transcript read in full: it reproduced the bug, made a first fix that failed its own test, then a second that passed), so this is memory, not a leak: today's Django contains that code, and models have read Django many times. [`run.py`](run.py) now measures it per run, from the saved patches:

| | Haiku | Sonnet | Opus |
| --- | --: | --: | --: |
| Share of the fix's added lines written verbatim, mean | 46% | 43% | 72% |
| Runs that repeat one of the fix's comments word for word, of the 3 whose fix adds one | 1 | 1 | 2 |

On two of the three tasks whose fix adds a comment (`django 11265`, `sympy 13615`), Opus's patch is the maintainers' fix, 100% verbatim. One-line fixes match for every model, and that means nothing: there is only one way to write them.

**So the pilot can't separate the arms, and what separates them is partly memory.** Recall flatters every model, and Opus most. A full run of this pool would mostly measure which model remembers Django.

### What would answer it

Tasks the models can't have seen: fixes merged after their training cutoff, with the tests that came with them. Most of this harness carries over: the grader controls (the real fix must pass, a do-nothing patch must fail), the sandboxed agent and the recall measure. What's missing is the task set, and images for it, since official ones exist only for published tasks. Building one from recent Django and SymPy commits is the next step; Django's issue tracker is blocked from this environment, SymPy's issues are on GitHub.

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

- **The grader can tell a fix from no fix.** On every task run, the reference fix must resolve and a patch that only adds an unrelated file must not; `gold.jsonl` records both per task. In the pilot both held on all 8 tasks that passed the image check (for example, Django 11490: 1/1 FAIL_TO_PASS and 23/23 PASS_TO_PASS tests).
- **No future commit in the image.** The images' repositories hold exactly the history up to the base commit, plus the empty marker commit: no other refs, no unreachable commits (`git fsck`). Each task's record says so.
- **The model works in the grader's environment.** In the smoke run, `python` in the agent's shell reported Python 3.6.13 from the image's conda environment and imported Django from the agent's own folder, and Django's test runner ran there.
- **The sandbox holds.** In a probe, `curl https://github.com` was refused by the permission rules before it ran, and the agent's tool list was exactly Bash, Edit, Glob, Grep, Read and Write.
- **The effort flag is what sets effort.** `CLAUDE_EFFORT`, which the host session sets to its own level, is an output: Claude Code exports the active level to its shells. `--effort` on each run governs.
- **The dataset copy matches the images, with one exception.** On 8 of the 9 tasks reached, the copy's base commit was the parent of the image's empty marker commit and the copy's reference fix passed the copy's tests in the official image. On `django__django-13033` the image's repository was elsewhere; the task was excluded before any model ran, and which side is wrong wasn't investigated.

## Limits

- **The dataset is a copy.** Hugging Face, the usual source, is blocked where this was built, so the tasks come from [aorwall/moatless-tools](https://github.com/aorwall/moatless-tools) (commit and SHA-256 in [`pool.json`](pool.json)). Two checks tie it to the real thing: every image's repository sits on the copy's base commit, and the copy's reference fix passes the copy's tests in the official image. The issue texts can't be checked that way.
- **Public tasks, likely seen in training.** SWE-bench has been public since October 2023 and Verified since August 2024, and the fixes are in the projects' public history. Bigger models may remember more, and that would favour Opus. Fresh tasks, from after the models' training cutoff, are the fix; they aren't here yet.
- **"Hard" means hard for 2023 and 2024 systems.** It is the best third-party difficulty signal available offline. OpenAI's own difficulty labels are on a host this environment can't reach.
- **Two repositories.** Django and SymPy are 61% of Verified, but the other ten projects are left out.
- **Not a leaderboard number.** The agent, its prompt and its sandbox are ours, and the restricted shell may cost a model turns. The grade is the official one. Compare arms with each other, not with published scores.
- **One attempt.** SWE-bench's own measure. The agent can run the project's tests while it works; the hidden tests are never shown.
