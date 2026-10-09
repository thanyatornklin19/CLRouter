# Benchmark: Aider polyglot exercises

Third-party tasks, third-party tests. 225 exercises from Exercism in six languages, curated by the Aider project as [`polyglot-benchmark`](https://github.com/Aider-AI/polyglot-benchmark). This is the benchmark behind claims C1 and C2 in [`../PROTOCOL.md`](../PROTOCOL.md).

**Status: harness built and checked; one pilot run (below). The pilot supports no claim.**

## The pilot, 2026-10-09

30 exercises (15 Python, 15 Go, drawn at random with seed 20261009), one run each of Haiku, Sonnet and Opus at medium effort, Claude Code 2.1.295. Full rows: [`results/pilot-2026-10-09`](results/pilot-2026-10-09).

| Model | Pass at 1 | Pass at 2 | Cost per exercise (both attempts) | Mean time |
| --- | --: | --: | --: | --: |
| Haiku | 22/30 = 73% (56 to 86%) | 29/30 = 97% (83 to 99%) | $0.011 | 104 s |
| Sonnet | 26/30 = 87% (70 to 95%) | 30/30 = 100% (89 to 100%) | $0.093 | 67 s |
| Opus | 30/30 = 100% (89 to 100%) | 30/30 = 100% (89 to 100%) | $0.159 | 32 s |

*Pass at 1* is the first attempt, with no test feedback. *Pass at 2* adds a second attempt that is shown the tail of the failing test output (not the test files), as Aider does. Intervals are 95% Wilson. Total spend for the pilot: $7.89.

**Pass at 1, paired over the same exercises:**

- Haiku − Opus: −26.7 points (−43.3 to −13.3). Opus alone solved 8, Haiku alone 0. Exact sign test p = 0.008.
- Sonnet − Opus: −13.3 points (−26.7 to −3.3). Opus alone solved 4, Sonnet alone 0. Exact p = 0.125.
- Haiku − Sonnet: −13.3 points (−30.0 to 0.0). Sonnet alone 5, Haiku alone 1. Exact p = 0.219.

**Pass at 2:** no pair differs by more than one exercise.

### Why the first-attempt gap isn't about coding

The first version of this report would have said "Opus is better, Haiku is worse". Before saying it, each of the 9 exercises where the models differed was opened and the failing test read. Classified by the author, so the judgement is subjective:

| Exercise | Failed | Why | Could the task tell the model? |
| --- | --- | --- | --- |
| go-protein-translation | Haiku | tests need exported `ErrStop` and `ErrInvalidBase` | **No.** Neither name is in the instructions or the stub. |
| go-trinary | Sonnet, Haiku | the stub reads `ParseTrinary(arg string, want int64, ok bool)`; the tests call `res, err := ParseTrinary(arg)` | **No.** The stub contradicts the tests. Haiku kept the stub's signature, Sonnet guessed `bool`. |
| python-pov | Haiku | exact error message | **No.** The task says the message must match, not what it is. |
| python-tree-building | Sonnet, Haiku | exact error message | **No.** Same. |
| python-grade-school | Haiku | tests expect `add_student` to return `[True]`, it returned `True` | **No.** The return value isn't described. |
| go-simple-linked-list | Haiku | `Array()` order (got `[3 2 1]`, want `[1 2 3]`) | Ambiguous. |
| go-two-bucket | Sonnet | goal 0 must be an error | Ambiguous. |
| python-list-ops | Haiku | wrong results in two functions | Ambiguous. |
| go-forth | Sonnet, Haiku | Sonnet: negative numbers not read as numbers. Haiku failed the same test; its reason wasn't read | Probably yes. A real mistake. |

So 5 of the 9 turned on something the model couldn't know, 3 are ambiguous, and 1 looks like a real coding mistake. Of the 4 exercises Sonnet failed and Opus passed, only `go-forth` is clearly about ability.

Opus matched exact strings the task never gave (the messages in `python-pov` and `python-tree-building`) on its first attempt. That is more likely recall of these public exercises than inference, but a pilot of this size can't separate recall from skill.

### What the pilot shows, and doesn't

- **It shows** that with a failing-test message to go on, the cheapest model got 29 of 30 and the middle one 30 of 30, at about 7% and 58% of Opus's cost per exercise. The one remaining failure was `go-trinary`, whose stub contradicts its tests.
- **It shows** that the first-attempt gap is mostly about details a task may not state. That fits the [tax benchmark](../thai-tax): there Haiku was silently wrong with nothing to tell it so, and with locked tests it was right.
- **It doesn't show** that Sonnet equals Opus, or the reverse. At pass at 2 all three are near the ceiling on these exercises, so this set can't separate them. If the question is where Opus earns its price, the tasks need to be harder, probably repository-level work.
- **It doesn't show** anything about exercises outside Python and Go, or about prompts that aren't build tasks.
- **It is one run per cell.** Hand-classifying the failures is the author's judgement.

## What the harness does

- [`prepare.py`](prepare.py) packs each exercise into a store outside the repository:
  - `start/` holds what the model sees: the stub files, any support code, and an `INSTRUCTIONS.md`.
  - `tests.tar` holds the hidden tests.
  - `spec.json` lists the solution and test files.
- [`run.py`](run.py) copies `start/` into a fresh folder and runs Claude Code on it. It puts the hidden tests back and runs them. If they fail, it runs a second attempt (`claude --continue`) with the tail of the output, hides the tests again, and scores again. It records cost, time and both results, then summarises with 95% intervals.

```
git clone --depth 1 https://github.com/Aider-AI/polyglot-benchmark SRC
python3 bench/aider-polyglot/prepare.py --src SRC --store ~/.bench-store/polyglot --languages python,go
rm -rf SRC        # the clone holds the answers
python3 bench/aider-polyglot/run.py --store ~/.bench-store/polyglot --out /tmp/pg \
    --models haiku,sonnet,opus --effort medium --n 30
```

Run it with `--out` somewhere outside this repository's tree, so the model can't wander into the harness.

## What was checked on the harness itself

- **The answer key is kept away from the model.** The exercise folders ship a reference solution (`.meta/example.*`) and write-ups of approaches (`.approaches/`). `prepare.py` leaves them out of `start/`, and the clone is deleted after packing.
- **Every test-named file is hidden.** The first version hid only the files each exercise's config lists as tests, and three Go exercises (`bottle-song`, `robot-simulator`, `two-bucket`) leaked extra `*_test.go` files to the model. Found by a scan, fixed.
- **The official reference solution passes the hidden tests as this harness runs them, for all 73 Python and Go exercises** (34 and 39). An exercise where it didn't would be left out, so a failure means the model's code failed. A first version of the check failed on all of Python, because it called a Python without `pytest`.
- **Go: tests the model wrote for itself are deleted** before the hidden ones are put back.
- **Each run's transcript is searched.** `touched` counts places where the model's own tool calls name the store, the tests archive or another run's folder. `seen` counts places where only a tool's output showed them. Pilot result: `touched` 0 in all 90 runs; `seen` 3, in one run.
- **The pilot was also read by hand,** for any command that leaves the run's own folder. Two Haiku runs looked around: `find / -name simple_linked_list.py` (it had already written its solution, and never rewrote it) and `ls ../ ../../` in `go-two-bucket`. Both listed names only, neither opened another run's file, and both passed at the first attempt. No run opened an answer key or another model's solution.
- **Two audit bugs were found in the pilot itself.** The first audit counted a model's own folder as another run's, and didn't tell "listed" from "opened". Both are fixed. A bare `ls ../` shows only folder names, so the automated check can't catch it; that is why the commands were read.

## What it is not

- **Not Aider's leaderboard protocol.** This is agentic (Claude Code), the tests are hidden, and the second attempt is the only feedback. Our numbers are not comparable to the leaderboard.
- **Python and Go only so far,** because those toolchains run here without network access. Rust, C++, JavaScript and Java are not packed.
- **Puzzles, not repositories.** It says nothing about large-codebase work, and every task is a build task, so it can't test the router. That is [`PROTOCOL.md`](../PROTOCOL.md)'s routing table.
- **The exercises are public** and may have been seen in training.
- **Some exercises can't be solved from their text** (the table above). Pass at 2 is the fairer measure for that reason, and it is the primary one in [`PROTOCOL.md`](../PROTOCOL.md) from version 1.1.
