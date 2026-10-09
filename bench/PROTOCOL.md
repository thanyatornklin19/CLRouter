# Benchmark protocol

**Version 1.2, 2026-10-09. Version 1 was written before any run; 1.1 and 1.2 each precede every run they govern (see the changelog).** Thresholds change only before the run they govern, and every change is logged at the bottom with its date. A result is reported whether or not it meets its rule.

## Why this exists

The first two benchmarks in this repo ([`thai-tax`](thai-tax) and a spreadsheet engine) were designed, tested and scored by the same author who then tuned the router, with one or two runs per cell. They are evidence that something is worth testing. They are not proof. This protocol is what proof has to look like.

## Claims and their pass rules

Each claim below is a sentence the README may say only if its rule is met. The margins are proposals: change them before the first run, not after.

| # | Claim | Test | Rule |
| --- | --- | --- | --- |
| C1 | On building code, Sonnet at medium is as good as Opus at high, for less | [`aider-polyglot`](aider-polyglot), 3 runs per arm | On pass at 2, the lower bound of the 95% interval for (Sonnet − Opus) is at least −5 points, **and** Sonnet's cost is at most 50% of Opus's. Pass at 1 is reported beside it. |
| C2 | High effort buys nothing on builds | Same task set, Sonnet at medium and at high | On pass at 2, the 95% interval for (high − medium) contains 0, **and** high costs at least 1.5× medium. |
| C3 | The router sends each prompt to a model that is good enough, for less | Routing table (below), run once on the frozen test split | It recovers at least 90% of the gap between always-Haiku and always-Opus quality, at no more than 60% of always-Opus cost, **and** beats random routing at the same share of calls by at least 5 points of quality. |
| C6 | On hard real bug fixes, Sonnet at medium is as good as Opus at high, for less. This is the router's own call: it sends 69 of the 71 hard issues to Sonnet at medium | [`swe-bench-hard`](swe-bench-hard), 3 runs per arm | On resolved rate (the official SWE-bench grade, one attempt), the lower bound of the 95% paired interval for (Sonnet − Opus) is at least −5 points, **and** Sonnet's cost is at most 50% of Opus's. |
| C7 | On hard real bug fixes, Opus at high earns its price | Same runs | The 95% paired interval for (Opus − Sonnet) lies wholly above 0. C6 and C7 can't both hold; if neither does, the README says the benchmark can't tell, and gives the interval. |
| C4 | It saves money in real use without more redos | Field holdout inside the plugin | Not set yet. The rule is fixed before the first data is collected, not after. |
| C5 | It saves five-hour quota on Pro and Max | A-B-A-B protocol on a real subscription | Not set yet. Same rule: fixed before data. |

## Rules for every benchmark

1. **Tests are not ours.** Tasks and tests come from a third party, or the rules behind our own are checked against an official source and the result is published with the benchmark. Anything we wrote ourselves is labelled **author-written** wherever its numbers appear.
2. **Dev and test are separate, and the router is frozen before the test split runs.** The router is tuned on dev prompts only. The commit that is run on test is recorded. The test split is run once.
3. **At least 3 runs per arm per task** for any comparison a claim depends on. Pass rates are reported with 95% intervals (Wilson for one arm, paired bootstrap over tasks for a difference). A difference of one task in twenty is not reported as a difference.
4. **Everything is pinned and printed with the result:** Claude Code version, model ids, effort, date, harness commit, the exact prompt given to the model.
5. **No answer key on the model's disk.** Reference solutions and hidden tests are never in a folder the model can read while it works. After each run, its transcript is searched twice and both counts are reported: `touched` (the model's own tool calls name the answer key or another run's folder) and `seen` (only a tool's output showed it). A run with `touched` above 0 is excluded and repeated. A run with `seen` above 0 is read by hand and what the reading found is recorded. Commands that leave the run's own folder are also read by hand, because a bare `ls ../` shows only names and the search can't catch it.
6. **Every run is counted.** Failed runs stay in the denominator. A run is repeated only when it died of infrastructure (a timeout before any model call, a network error), and the repeat is noted.
7. **Cost is what the API reports** (`total_cost_usd`, list prices). Subscription quota is reported separately and never converted into dollars.
8. **Pilots don't count.** A pilot measures cost and checks the harness. Its numbers are labelled as such and never support a claim.

## The routing table (for C3)

Run every prompt on every arm once (Haiku, Sonnet, Opus, each at the effort the router would choose, and at medium), and store `prompt × arm → (quality, cost)`. Any router can then be scored by lookup, at no further cost, against four baselines: always-Haiku, always-Sonnet, always-Opus, and random routing at the same share of calls.

- **Prompts** come from real Claude Code use, not from the author: the maintainer's own history (kept local, redacted) plus contributed prompts. They are split into dev and test before anything is run.
- **Quality** comes from a blind pairwise judge against the always-Opus answer, with a rubric fixed in advance. A subset of at least 50 pairs is also judged by a person, blind. If the judge and the person disagree on more than 20% of that subset, the judge's scores are not used.
- **Metrics** follow RouteLLM: performance gap recovered (PGR) and the share of calls to the strong model needed to reach a target quality (CPT), plus the cost–quality curve.

## Pass at 1 and pass at 2

A task's hidden tests may need something its text never states: an exported name, an exact error message, a return type. With one attempt and no feedback, the first attempt then measures whether the model happens to know the convention, which is recall of a public exercise as much as coding. Pass at 1 is the first attempt. **Pass at 2** adds one more attempt that is shown the tail of the failing test output (never the test files), as Aider does and as an agent that runs tests would experience. Both are reported; pass at 2 is the one C1 and C2 use. The pilot is why: [`aider-polyglot`](aider-polyglot#why-the-first-attempt-gap-isnt-about-coding).

C6 and C7 use one attempt, SWE-bench's own measure. There the issue text is the real specification, human annotators screened every Verified task for a clear issue and fair tests, and the agent can run the project's own test suite while it works.

## Known limits, stated now

- **Public benchmarks are memorised, and not equally.** Aider's exercises and SWE-bench's fixes have been public for years. The [SWE-bench pilot](swe-bench-hard#why-these-numbers-dont-answer-the-question) found Opus writing the maintainers' patch word for word, comments included, more often than the cheaper models, so recall doesn't cancel out between arms: it flatters the bigger model. On public tasks, every result reports a verbatim-recall measure beside it, and a claim about Sonnet against Opus needs tasks newer than the models.
- **At pass at 2 the pilot's models were at the ceiling.** On its 30 exercises they scored 97%, 100% and 100%, so the set may not be able to separate Sonnet from Opus. If it can't, C1's "as good" is met trivially and the real question, where Opus earns its price, needs harder tasks.
- **Aider polyglot is puzzles, not repositories.** It says nothing about navigating a large codebase; [`swe-bench-hard`](swe-bench-hard) is for that. And since every task in either is a build task, the router sends nearly all of it to one model. That is why C3 has its own table.
- **Our harnesses are not the leaderboards' protocols.** Both are agentic (Claude Code). Polyglot hides the tests and gives a second attempt only the failing output. SWE-bench grading is the official harness, unchanged, but the agent, its prompt and its sandbox are ours. Neither set of numbers is comparable to a leaderboard.
- **An LLM judge favours its own family.** This is why a person scores a subset.
- **Field proxies are not quality.** An interrupt or a re-ask is a signal, not a measurement.

## Changelog

- 2026-10-09: version 1.
- 2026-10-09: after the SWE-bench pilot, the known limit on memorisation was rewritten: the pilot showed recall differs between arms, so it doesn't cancel out. Results on public tasks now report a verbatim-recall measure. No claim, rule or threshold changed.
- 2026-10-09: version 1.2, before any model ran on [`swe-bench-hard`](swe-bench-hard). Adds that benchmark and claims C6 and C7, because the polyglot pilot was at the ceiling. The task pool, the arms and the pass rules were fixed before the first model run on it; only the harness's own checks (reference fix passes, a do-nothing patch fails, one smoke run) came first.
- 2026-10-09: version 1.1, after the pilot and before any run it governs. Pass at 2 became the primary measure for C1 and C2, because the pilot showed pass at 1 rewards details a task doesn't state (5 of the 9 exercises where models differed). The audit now counts `touched` and `seen` separately and requires a hand reading of commands that leave a run's folder. The ceiling is listed as a known limit. The thresholds were not changed.
