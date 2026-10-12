# Benchmarks

What CLRouter's choices rest on, and how sure each piece is. The rules every result has to follow, set before the runs they govern, are in [`PROTOCOL.md`](PROTOCOL.md).

| Benchmark | Tasks and tests | Graded by | Status |
| :-- | :-- | :-- | :-- |
| [`thai-tax`](thai-tax) | A Thai income tax web app, 20 hidden tests | The author's own tests | Done, 1 or 2 runs per model and effort. The tax rules aren't yet checked against the 2567 forms. |
| [`aider-polyglot`](aider-polyglot) | 30 Exercism exercises in Python and Go | The exercises' own tests, hidden | Pilot. Too easy at the second attempt to separate the models. |
| [`swe-bench-hard`](swe-bench-hard) | 8 hard Django and SymPy bug reports from SWE-bench Verified | The official SWE-bench harness | Pilot. Too easy for current models, and the fixes are remembered. |

**What they agree on:** Sonnet stays within a task of Opus at roughly 30 to 60% of the price, and Haiku keeps up when tests can tell it it's wrong. Without them, it got the tax rules right only at high effort, which cost as much as Sonnet.

**What none of them shows yet:** where Opus earns its price. That needs tasks newer than the models, which no public benchmark here has.

**No claim in the protocol has met its pass rule yet.** Every number above is labelled for what it is.
