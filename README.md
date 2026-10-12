<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <img alt="CLRouter: the right model and effort for every prompt" src="assets/banner-light.svg">
</picture>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="docs/how-it-works.md">How it works</a> ·
  <a href="bench">Benchmarks</a> ·
  <a href="README.th.md">ภาษาไทย</a>
</p>

Running Opus at high effort on every prompt is the expensive default. CLRouter picks the model and the effort per prompt, from what each one was measured to be good at, and asks before it switches.

```
 CLRouter
 Haiku fits this prompt (question or explanation). Run it on Haiku at low effort instead of Opus?

 ❯ 1. Use Haiku for this prompt
   2. Keep Opus
   3. Auto-route this session
   4. Turn off this session
```

## Measured, not guessed

Three benchmarks, each model scored by tests it never saw:

| Benchmark | Haiku | Sonnet | Opus |
| :-- | :-- | :-- | :-- |
| [Thai tax web app](bench/thai-tax), 20 hidden tests | 18, 19 of 20 · $0.07 | 20, 20 of 20 · $0.16 | 19 of 20 · $0.56 |
| [30 Exercism exercises](bench/aider-polyglot), second attempt | 29 of 30 · $0.01 | 30 of 30 · $0.09 | 30 of 30 · $0.16 |
| [8 hard SWE-bench tasks](bench/swe-bench-hard), official grader | 8 of 8 · $0.04 | 7 of 8 · $0.10 | 8 of 8 · $0.33 |

<sub>Cost per task, one or two runs per cell. Effort: tax app, Haiku and Sonnet at medium and Opus at high; exercises, all at medium; SWE-bench, Haiku and Opus at high and Sonnet at medium. All three are pilots, and the tax tests are the author's own: none of this meets the bar set in [the protocol](bench/PROTOCOL.md).</sub>

- **Sonnet was never more than one task behind Opus**, at roughly 30 to 60% of the price. So code goes to Sonnet.
- **Haiku keeps up when it can find out it's wrong**, from failing tests or the project's own test suite. On the tax app at medium effort, with nothing to check it, it got a tax rule wrong in both runs, behind a page that looked finished. At high effort it got both right, but at Sonnet's price and over four times as slow. So answers go to Haiku, and money or legal rules go to Sonnet.
- **When Opus earns its price isn't shown yet.** The exercises and bug fixes were too easy for current models, and the public fixes are remembered: Opus wrote the maintainers' patch word for word on two SWE-bench tasks. Settling it needs tasks newer than the models.

## Install

In Claude Code:

```
/plugin install clrouter --marketplace thanyatornklin19/CLRouter
```

It works with an API key or a Pro/Max plan.

## What it does

- **Picks the model.** Answers go to Haiku, code and exact rules to Sonnet, architecture and security to Opus.
- **Picks the effort.** Low for answers, medium for code, high for deep work. Never max.
- **Switches only when it's cheaper**, counting the cache it has to rebuild.
- **Learns your answers.** Say yes twice and it stops asking. Say no three times and it stops offering.
- **Shows what it saved**, in dollars and in your five-hour window:

```
› /clrouter stats
CLRouter, last 7 days: 212 turns.
- Sent to another model: 64 (Haiku 51, Sonnet 13). Effort only: 98. Left alone: 50.
- Those turns cost $0.41. On your session's model they'd have cost at least $2.90: saved at least $2.49.
- Five-hour window used per turn: Haiku 0.1%, Sonnet 0.8%, Opus 2.3%.
```

<sub>Example output. Yours comes from your own turns.</sub>

## Commands

| Command | What it does |
| :-- | :-- |
| `/clrouter` | Shows the mode, what it has learned, and the last call it made. |
| `/clrouter stats [days]` | Shows cost, savings and the five-hour window. |
| `/clrouter test <prompt>` | Shows which model and effort a prompt gets, and why. |
| `/clrouter ask \| auto \| suggest \| off` | Sets the mode for this session. |
| `/clrouter forget` | Clears your learned answers. |
| `/clrouter:dev <task>` | Writes locked tests, then has the cheapest model that passes them write the code. Experimental. |

## Should you use it?

Yes, as a beta, in the default `ask` mode: nothing switches without your click.

1. Install it and keep `ask` for a week.
2. Check `/clrouter stats` for what it saved and how often you said no.
3. If you rarely say no, switch to `/clrouter auto`.

Pick Opus yourself for architecture or a bug that spans services, and keep tests around if you accept Haiku for code. If you need a guaranteed cost or quality number for a team, wait: nothing here meets that bar yet.

## Good to know

- **Beta.** It's built on Claude Code's early-access plugin API (tested on 2.1.295), which can change.
- **Accuracy.** On prompts it was never tuned on, it picked right 14 times in 20. It never sent code or exact rules to Haiku.
- **Savings are a floor.** They are never overstated, and a loss is shown as a loss.
- **`/clrouter:dev` is experimental.** A long stage can finish on your session's model instead of its own ([known issue](docs/how-it-works.md)).
- **Not measured yet:** routing for Opus-level work, savings in real use, and the five-hour reading on a real Pro account.

## Help it get better

The most useful thing you can send is prompts: real ones from your own work, redacted, each with the model you'd have wanted. They let the router be measured on work it wasn't built from. [Open an issue →](https://github.com/thanyatornklin19/CLRouter/issues)

<sub>[How it works](docs/how-it-works.md) · [Benchmarks](bench) · MIT</sub>
