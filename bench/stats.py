"""Statistics shared by the benchmarks: one-arm intervals and paired tests over tasks."""
import math
import random


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson interval for k successes out of n."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def bootstrap_diff(a: dict[str, float], b: dict[str, float], iters: int = 5000, seed: int = 1) -> tuple[float, float, float]:
    """Mean of a - b over the tasks both have, with a 95% bootstrap interval that resamples tasks."""
    tasks = sorted(set(a) & set(b))
    if not tasks:
        return (0.0, 0.0, 0.0)
    rng = random.Random(seed)
    base = sum(a[t] - b[t] for t in tasks) / len(tasks)
    sims = sorted(sum(a[t] - b[t] for t in (rng.choice(tasks) for _ in tasks)) / len(tasks) for _ in range(iters))
    return base, sims[int(0.025 * iters)], sims[int(0.975 * iters)]


def sign_test(only_a: int, only_b: int) -> float:
    """Exact two-sided sign test on the tasks where exactly one of two arms succeeded."""
    n = only_a + only_b
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(only_a, only_b) + 1)) / 2 ** n)
