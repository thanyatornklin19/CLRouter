Tasks graded on every arm: 8. Excluded before any model ran (image check or grader controls failed): 1 (django__django-13033).

| Arm | Runs | Resolved (95% CI) | Mean cost | Cost per resolved | Mean time | Errors | Denied cmds | Touched | Seen | Net |
| --- | --: | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| haiku-high | 8 | 8/8 = 100% (68% to 100%) | $0.04 | $0.04 | 4.1 min | 0 | 55 | 0 | 0 | 0 |
| sonnet-medium | 8 | 7/8 = 88% (53% to 98%) | $0.10 | $0.12 | 2.4 min | 0 | 13 | 0 | 0 | 0 |
| opus-high | 8 | 8/8 = 100% (68% to 100%) | $0.33 | $0.33 | 2.7 min | 0 | 24 | 0 | 0 | 0 |

Paired difference over the same tasks (95% bootstrap interval; exact sign test on tasks only one arm resolved):

- haiku-high − sonnet-medium: +12.5 points (+0.0 to +37.5); haiku-high alone 1, sonnet-medium alone 0, exact p = 1.000
- haiku-high − opus-high: +0.0 points (+0.0 to +0.0); haiku-high alone 0, opus-high alone 0, exact p = 1.000
- sonnet-medium − opus-high: -12.5 points (-37.5 to +0.0); sonnet-medium alone 0, opus-high alone 1, exact p = 1.000

Router lookup (keyword router on each issue's text; no extra runs):

- Verdicts: sonnet (build, high confidence): 8
- From a opus session: resolves 7/8, $0.10 per task
- From a sonnet session: resolves 7/8, $0.10 per task
- Cheapest arm that resolved each task (no router can beat this): 8/8, $0.04 per task (unresolved tasks counted at $0)

Recall of the maintainers' fix (verbatim lines in the model's patch):

- haiku-high: 46% of the fix's added lines on average; reproduced at least one of the fix's comments word for word in 1 of the 3 runs whose fix adds a comment
- sonnet-medium: 43% of the fix's added lines on average; reproduced at least one of the fix's comments word for word in 1 of the 3 runs whose fix adds a comment
- opus-high: 72% of the fix's added lines on average; reproduced at least one of the fix's comments word for word in 2 of the 3 runs whose fix adds a comment

Model ids reported by Claude Code: claude-haiku-5-5, claude-opus-5-5, claude-sonnet-5-5
