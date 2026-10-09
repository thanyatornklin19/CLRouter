Exercises scored: 30. Effort: medium.

| Model | Runs | Pass at 1 (95% CI) | Pass at 2 (95% CI) | Mean cost, both attempts | Mean time | Touched | Seen |
| --- | --: | --- | --- | --: | --: | --: | --: |
| haiku | 30 | 22/30 = 73% (56% to 86%) | 29/30 = 97% (83% to 99%) | $0.011 | 104 s | 0 | 3 |
| sonnet | 30 | 26/30 = 87% (70% to 95%) | 30/30 = 100% (89% to 100%) | $0.093 | 67 s | 0 | 0 |
| opus | 30 | 30/30 = 100% (89% to 100%) | 30/30 = 100% (89% to 100%) | $0.159 | 32 s | 0 | 0 |

Pass at 1: paired difference over the same exercises (95% bootstrap interval; exact sign test on the exercises where only one of the two passed):

- haiku − sonnet: -13.3 points (-30.0 to +0.0); haiku alone 1, sonnet alone 5, exact p = 0.219
- haiku − opus: -26.7 points (-43.3 to -13.3); haiku alone 0, opus alone 8, exact p = 0.008
- sonnet − opus: -13.3 points (-26.7 to -3.3); sonnet alone 0, opus alone 4, exact p = 0.125

Pass at 2: paired difference over the same exercises (95% bootstrap interval; exact sign test on the exercises where only one of the two passed):

- haiku − sonnet: -3.3 points (-10.0 to +0.0); haiku alone 0, sonnet alone 1, exact p = 1.000
- haiku − opus: -3.3 points (-10.0 to +0.0); haiku alone 0, opus alone 1, exact p = 1.000
- sonnet − opus: +0.0 points (+0.0 to +0.0); sonnet alone 0, opus alone 0, exact p = 1.000
