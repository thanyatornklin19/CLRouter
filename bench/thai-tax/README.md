# Benchmark: Thai income tax web app

One task, given word for word to every approach: build a web page that calculates Thai personal income tax for tax year 2567 (salary income). See [`task.md`](task.md).

The task names the deductions but not their caps or the tax rates. The model has to know Thai tax law, and that is where cheap models slip.

## How it is scored

- **Hidden tests** ([`hidden-tests.mjs`](hidden-tests.mjs)): 20 tests of `calculateTax` that no model sees. They check every cap, every bracket boundary, the second-child rule, refunds and a full return.
- **Browser check** ([`ui-check.mjs`](ui-check.mjs)): opens the built page in Chromium, fills in two returns, presses calculate and reads the numbers off the page.
- **Cost**: the API bill each run reports.

Both checks pass on a reference implementation ([`reference/`](reference/)) first, so a failure means the app is wrong, not the test.

## Results (October 2026, Claude Code 2.1.295)

| Approach | Runs | Avg cost | Hidden tests | Browser check | Avg time |
| --- | --- | --- | --- | --- | --- |
| **Sonnet alone** | 2 | **$0.16** | **20/20, 20/20** | 2/2, 2/2 | **57 s** |
| Haiku alone | 2 | $0.07 | 18/20, 19/20 | 1/2, 2/2 | 157 s |
| Opus alone | 2 | $0.51 | 20/20, 19/20 | 2/2, 2/2 | 121 s |
| Old pipeline (Opus plan and review, Sonnet code) | 1 | $0.72 | 20/20 | 2/2 | 161 s |
| Cascade, Opus writes the tests | 2 | $0.76 | 20/20, 20/20 | 2/2, 2/2 | 251 s |
| Cascade, Sonnet writes the tests | 1 | $0.26 | 20/20 | 2/2 | 182 s |

Per-run detail is in [`results.json`](results.json).

**What it shows:**

- **Sonnet alone gave the most correctness per baht.** It was right both times, at a third of Opus's cost and in under a minute.
- **Haiku is cheap and quietly wrong.** Both of its pages looked finished, but each run got a different legal cap wrong:
  - run 1 didn't limit life plus health insurance to 100,000 together, so the tax came out 17,100 instead of 17,600;
  - run 2 didn't cap parents' health insurance at 15,000.

  A person using the page would never know.
- **Opus was not safer.** Its second run missed the provident fund's 15% cap.
- **Locked tests work.** In every cascade run, the code that passed was written by **Haiku**, and every one scored 20/20, against 18 and 19 for Haiku alone. The tests carried the tax rules Haiku didn't know, and the lock stopped it from editing them to pass.
- **The cascade didn't save money on a task this size.**
  - Writing the tests costs about as much as writing the code. With Opus writing them, they cost more than Opus doing the whole job.
  - With Sonnet writing them, the cascade cost 1.7× Sonnet alone.
  - It can only win when the code is much bigger than its tests. This benchmark doesn't measure that.

## Effort

The runs above used `medium`, the default. The same task at other efforts (`EFFORT=<level> bench/thai-tax/run.sh ...`):

| Model and effort | Runs | Avg cost | Hidden tests | Avg time |
| --- | --- | --- | --- | --- |
| Sonnet low | 2 | $0.14 | 20/20, 20/20 | 48 s |
| Sonnet medium | 2 | $0.16 | 20/20, 20/20 | 57 s |
| Sonnet high | 1 | $0.31 | 20/20 | 134 s |
| Haiku medium | 2 | $0.07 | 18/20, 19/20 | 157 s |
| Haiku high | 2 | $0.16 | 20/20, 20/20 | 260 s |
| Haiku max | 2 | $1.80 | 20/20, 20/20 | 1,465 s |
| Opus medium | 2 | $0.51 | 20/20, 19/20 | 121 s |
| Opus high | 1 | $0.56 | 19/20 | 153 s |

What it shows:

- **Effort fixes carelessness, not ignorance.**
  - Haiku at medium got a different cap wrong each run, and at high it got none wrong.
  - Opus missed the same rule (the provident fund's 15% cap) at medium and at high.
- **High and max buy nothing on a build like this.**
  - Sonnet at high cost twice as much as at medium, for the same score.
  - Haiku at max cost 11 times as much as at high and took 25 minutes, for the same score.
- **Low held up.** Sonnet at low passed both runs. So did Haiku at low on the spreadsheet benchmark (48/48, $0.035).

Two runs per approach is not enough for statistics. Treat the table as evidence, not proof.

## Run it yourself

```
bench/thai-tax/run.sh sonnet-1 sonnet -
bench/thai-tax/run.sh cascade-1 sonnet . "/clrouter:dev "
python3 bench/thai-tax/score.py
```

Run these from the repository root. `run.sh` takes:

- a run name;
- the session model;
- a plugin folder, or `-` for none;
- an optional prompt prefix.

`score.py` scores every run under `runs/`. The browser check needs Playwright with Chromium.

Runs execute with `--dangerously-skip-permissions` inside `runs/work-*`, so use a machine you don't mind them writing to. Keep `hidden-tests.mjs` out of the models' reach: a model that reads it can pass it without knowing the rules.
