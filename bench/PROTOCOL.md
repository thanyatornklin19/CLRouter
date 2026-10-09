# Benchmark protocol

**Version 1, written 2026-10-09, before any run it governs.** Thresholds change only before the run they govern, and every change is logged at the bottom with its date. A result is reported whether or not it meets its rule.

## Why this exists

The first two benchmarks in this repo ([`thai-tax`](thai-tax) and a spreadsheet engine) were designed, tested and scored by the same author who then tuned the router, with one or two runs per cell. They are evidence that something is worth testing. They are not proof. This protocol is what proof has to look like.

## Claims and their pass rules

Each claim below is a sentence the README may say only if its rule is met. The margins are proposals: change them before the first run, not after.

| # | Claim | Test | Rule |
| --- | --- | --- | --- |
| C1 | On building code, Sonnet at medium is as good as Opus at high, for less | [`aider-polyglot`](aider-polyglot), 3 runs per arm | The lower bound of the 95% interval for (Sonnet pass rate − Opus pass rate) is at least −5 points, **and** Sonnet's cost is at most 50% of Opus's. |
| C2 | High effort buys nothing on builds | Same task set, Sonnet at medium and at high | The 95% interval for (high − medium) contains 0, **and** high costs at least 1.5× medium. |
| C3 | The router sends each prompt to a model that is good enough, for less | Routing table (below), run once on the frozen test split | It recovers at least 90% of the gap between always-Haiku and always-Opus quality, at no more than 60% of always-Opus cost, **and** beats random routing at the same share of calls by at least 5 points of quality. |
| C4 | It saves money in real use without more redos | Field holdout inside the plugin | Not set yet. The rule is fixed before the first data is collected, not after. |
| C5 | It saves five-hour quota on Pro and Max | A-B-A-B protocol on a real subscription | Not set yet. Same rule: fixed before data. |

## Rules for every benchmark

1. **Tests are not ours.** Tasks and tests come from a third party, or the rules behind our own are checked against an official source and the result is published with the benchmark. Anything we wrote ourselves is labelled **author-written** wherever its numbers appear.
2. **Dev and test are separate, and the router is frozen before the test split runs.** The router is tuned on dev prompts only. The commit that is run on test is recorded. The test split is run once.
3. **At least 3 runs per arm per task** for any comparison a claim depends on. Pass rates are reported with 95% intervals (Wilson for one arm, paired bootstrap over tasks for a difference). A difference of one task in twenty is not reported as a difference.
4. **Everything is pinned and printed with the result:** Claude Code version, model ids, effort, date, harness commit, the exact prompt given to the model.
5. **No answer key on the model's disk.** Reference solutions and hidden tests are never in a folder the model can read while it works. After each run, its transcript is searched for any access to the answer-key locations, and the count is reported with the result.
6. **Every run is counted.** Failed runs stay in the denominator. A run is repeated only when it died of infrastructure (a timeout before any model call, a network error), and the repeat is noted.
7. **Cost is what the API reports** (`total_cost_usd`, list prices). Subscription quota is reported separately and never converted into dollars.
8. **Pilots don't count.** A pilot measures cost and checks the harness. Its numbers are labelled as such and never support a claim.

## The routing table (for C3)

Run every prompt on every arm once (Haiku, Sonnet, Opus, each at the effort the router would choose, and at medium), and store `prompt × arm → (quality, cost)`. Any router can then be scored by lookup, at no further cost, against four baselines: always-Haiku, always-Sonnet, always-Opus, and random routing at the same share of calls.

- **Prompts** come from real Claude Code use, not from the author: the maintainer's own history (kept local, redacted) plus contributed prompts. They are split into dev and test before anything is run.
- **Quality** comes from a blind pairwise judge against the always-Opus answer, with a rubric fixed in advance. A subset of at least 50 pairs is also judged by a person, blind. If the judge and the person disagree on more than 20% of that subset, the judge's scores are not used.
- **Metrics** follow RouteLLM: performance gap recovered (PGR) and the share of calls to the strong model needed to reach a target quality (CPT), plus the cost–quality curve.

## Known limits, stated now

- **Public benchmarks may be memorised.** Aider's exercises have been public for years. Absolute pass rates are unreliable; the comparison between arms, which share the exposure, is what we use.
- **Aider polyglot is puzzles, not repositories.** It says nothing about navigating a large codebase, and since every task is a build task the router would send all of it to one model. That is why C3 has its own table.
- **Our harness is not Aider's leaderboard protocol.** It is agentic (Claude Code), the tests are hidden, and there is one attempt with no test feedback. Our numbers are not comparable to the leaderboard.
- **An LLM judge favours its own family.** This is why a person scores a subset.
- **Field proxies are not quality.** An interrupt or a re-ask is a signal, not a measurement.

## Changelog

- 2026-10-09: version 1.
