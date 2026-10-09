# Benchmark: Aider polyglot exercises

Third-party tasks, third-party tests. 225 exercises from Exercism in six languages, curated by the Aider project as [`polyglot-benchmark`](https://github.com/Aider-AI/polyglot-benchmark). This is the benchmark behind claims C1 and C2 in [`../PROTOCOL.md`](../PROTOCOL.md).

**Status: harness built and checked, pilot only. No result here supports a claim yet.**

## What the harness does

- [`prepare.py`](prepare.py) packs each exercise into a store outside the repository:
  - `start/` holds what the model sees: the stub files, any support code, and an `INSTRUCTIONS.md`.
  - `tests.tar` holds the hidden tests.
  - `spec.json` lists the solution and test files.
- [`run.py`](run.py) copies `start/` into a fresh folder, runs Claude Code on it once, puts the hidden tests back, and runs them. It records cost, time and pass/fail, then summarises with 95% intervals.

```
git clone --depth 1 https://github.com/Aider-AI/polyglot-benchmark SRC
python3 bench/aider-polyglot/prepare.py --src SRC --store ~/.bench-store/polyglot --languages python,go
rm -rf SRC        # the clone holds the answers
python3 bench/aider-polyglot/run.py --store ~/.bench-store/polyglot --out /tmp/pg \
    --models haiku,sonnet,opus --effort medium --n 30
```

Run it from outside this repository's tree (`--out` somewhere else), so the model can't wander into the harness.

## What was checked on the harness itself

- **The answer key is kept away from the model.** The exercise folders ship a reference solution (`.meta/example.*`) and write-ups of approaches (`.approaches/`). `prepare.py` leaves them out of `start/`, and the clone is deleted after packing.
- **Every test-named file is hidden.** The first version hid only the files each exercise's config lists as tests, and three Go exercises (`bottle-song`, `robot-simulator`, `two-bucket`) leaked extra `*_test.go` files to the model. Found by a scan, fixed, and the scan is now part of how the store is checked.
- **The official reference solution passes the hidden tests as this harness runs them, for all 73 Python and Go exercises** (34 and 39). An exercise where it didn't would be left out, so a failure means the model's code failed. A first version of the check failed on all of Python, because it called a Python without `pytest`.
- **Each run's transcript is searched** for any touch of the store, the tests archive or a sibling run, and the count is printed with the result.
- **Go: tests the model wrote for itself are deleted** before the hidden ones are put back, so they can't fail the run on their own.

## What it is not

- **Not Aider's leaderboard protocol.** This is agentic (Claude Code), the tests are hidden, and there is one attempt with no test feedback. Our numbers are not comparable to the leaderboard.
- **Python and Go only so far,** because those toolchains run here without network access. Rust, C++, JavaScript and Java are not packed.
- **Puzzles, not repositories.** It says nothing about large-codebase work, and every task is a build task, so it can't test the router. That is [`PROTOCOL.md`](../PROTOCOL.md)'s routing table.
- **The exercises are public** and may have been seen in training.

## Pilot

30 exercises (15 Python, 15 Go, drawn at random with seed 20261009), one run each of Haiku, Sonnet and Opus at medium effort, to measure cost and check the harness. A pilot supports no claim. Results below when the run has finished.
