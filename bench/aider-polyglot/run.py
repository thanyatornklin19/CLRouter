#!/usr/bin/env python3
"""Runs Claude Code on packed polyglot exercises and scores it with hidden tests.

    python3 run.py --store ~/.bench-store/polyglot --out runs/pilot \\
        --models haiku,sonnet,opus --effort medium --n 30 --seed 20261009

One attempt per exercise, no test feedback: the model gets INSTRUCTIONS.md and
the stub files, edits them, and is scored by tests it never saw. Results are
appended to <out>/results.jsonl as they finish, so an interrupted run resumes
(finished model/exercise/repeat triples are skipped).

See ../PROTOCOL.md for what a result may be used to claim.
"""
import argparse
import json
import math
import os
import pathlib
import random
import re
import shutil
import subprocess
import tarfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import prepare  # test_command, test_env

PROMPT = (
    'INSTRUCTIONS.md describes a programming exercise. Implement it by editing {files}. '
    'Keep the names and signatures of the functions, types and classes already in the stubs: '
    'hidden unit tests will call them. Do not edit any other file. '
    'No test suite is provided; check your work however you like.'
)

LOCK = threading.Lock()


def load_tasks(store: pathlib.Path, languages: list[str]) -> list[dict]:
    tasks = []
    for d in sorted(store.iterdir()):
        spec_file = d / 'spec.json'
        if spec_file.exists():
            spec = json.loads(spec_file.read_text())
            if spec['lang'] in languages and spec['reference_ok']:
                spec['dir'] = str(d)
                tasks.append(spec)
    return tasks


def transcript_dir(workdir: pathlib.Path) -> pathlib.Path:
    return pathlib.Path.home() / '.claude' / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', str(workdir.resolve()))


def audit(workdir: pathlib.Path, workroot: pathlib.Path, store: pathlib.Path) -> int:
    """How many places in the transcript touch the answer key or a sibling run."""
    tdir = transcript_dir(workdir)
    if not tdir.exists():
        return 0
    text = ''.join(p.read_text(errors='ignore') for p in tdir.glob('*.jsonl'))
    own = re.escape(str(workdir.resolve()))
    hits = len(re.findall(re.escape(str(store)), text)) + len(re.findall(r'polyglot-benchmark|tests\.tar', text))
    hits += len(re.findall(re.escape(str(workroot.resolve())) + r'/(?!' + re.escape(workdir.relative_to(workroot).parts[0]) + r')', text))
    return hits


def run_one(task: dict, model: str, rep: int, args, workroot: pathlib.Path) -> dict:
    run_id = f'{model}-{rep}'
    workdir = workroot / run_id / f"{task['lang']}-{task['slug']}"
    if workdir.exists():
        shutil.rmtree(workdir)
    shutil.copytree(pathlib.Path(task['dir']) / 'start', workdir)

    cmd = [
        'claude', '-p', '--model', model, '--effort', args.effort,
        '--dangerously-skip-permissions', '--output-format', 'json',
        '--max-budget-usd', str(args.max_budget),
        PROMPT.format(files=', '.join(task['solution'])),
    ]
    row = {
        'task': f"{task['lang']}-{task['slug']}", 'model': model, 'effort': args.effort, 'rep': rep,
        'passed': False, 'cost': None, 'seconds': None, 'turns': None, 'error': None, 'audit': 0,
    }
    started = time.time()
    try:
        r = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, timeout=args.timeout, stdin=subprocess.DEVNULL)
        row['seconds'] = round(time.time() - started)
        try:
            out = json.loads(r.stdout)
            row['cost'] = out.get('total_cost_usd')
            row['turns'] = out.get('num_turns')
            if out.get('is_error'):
                row['error'] = str(out.get('result', ''))[:200]
        except json.JSONDecodeError:
            row['error'] = f'no json: {r.stderr[-200:]}'
    except subprocess.TimeoutExpired:
        row['seconds'] = args.timeout
        row['error'] = 'timeout'

    # Tests the model wrote for itself must not run beside the hidden ones:
    # `go test ./...` would run them and could fail on its own conflicts.
    if task['lang'] == 'go':
        for stray in workdir.rglob('*_test.go'):
            stray.unlink()
    with tarfile.open(pathlib.Path(task['dir']) / 'tests.tar') as tar:
        tar.extractall(workdir, filter='data')
    try:
        t = subprocess.run(
            prepare.test_command(task['lang'], task['tests']), cwd=workdir, env=prepare.test_env(),
            capture_output=True, text=True, timeout=240,
        )
        row['passed'] = t.returncode == 0
    except subprocess.TimeoutExpired:
        row['passed'] = False
    row['audit'] = audit(workdir, workroot, pathlib.Path(args.store).expanduser())
    return row


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def per_task_rate(rows: list[dict], model: str) -> dict[str, float]:
    by: dict[str, list[bool]] = {}
    for r in rows:
        if r['model'] == model:
            by.setdefault(r['task'], []).append(r['passed'])
    return {t: sum(v) / len(v) for t, v in by.items()}


def bootstrap_diff(a: dict[str, float], b: dict[str, float], iters: int = 5000, seed: int = 1) -> tuple[float, float, float]:
    tasks = sorted(set(a) & set(b))
    if not tasks:
        return (0.0, 0.0, 0.0)
    rng = random.Random(seed)
    base = sum(a[t] - b[t] for t in tasks) / len(tasks)
    sims = sorted(sum(a[t] - b[t] for t in (rng.choice(tasks) for _ in tasks)) / len(tasks) for _ in range(iters))
    return base, sims[int(0.025 * iters)], sims[int(0.975 * iters)]


def summarize(rows: list[dict], models: list[str], effort: str) -> str:
    done = [r for r in rows if r['error'] != 'timeout' or r['passed'] is not None]
    lines = [f'Exercises scored: {len({r["task"] for r in done})}. Effort: {effort}.', '']
    lines.append('| Model | Runs | Passed | Pass rate (95% CI) | Mean cost | Cost per pass | Mean time | Audit hits |')
    lines.append('| --- | --: | --: | --- | --: | --: | --: | --: |')
    for m in models:
        mine = [r for r in done if r['model'] == m]
        if not mine:
            continue
        k = sum(r['passed'] for r in mine)
        lo, hi = wilson(k, len(mine))
        cost = [r['cost'] for r in mine if r['cost'] is not None]
        total = sum(cost)
        secs = [r['seconds'] for r in mine if r['seconds'] is not None]
        lines.append(
            f'| {m} | {len(mine)} | {k} | {k / len(mine):.0%} ({lo:.0%} to {hi:.0%}) | '
            f'${total / max(len(cost), 1):.3f} | ${total / k:.3f} | {sum(secs) / max(len(secs), 1):.0f} s | '
            f'{sum(r["audit"] for r in mine)} |' if k else
            f'| {m} | {len(mine)} | 0 | 0% ({lo:.0%} to {hi:.0%}) | ${total / max(len(cost), 1):.3f} | n/a | '
            f'{sum(secs) / max(len(secs), 1):.0f} s | {sum(r["audit"] for r in mine)} |'
        )
    lines.append('')
    lines.append('Paired difference in pass rate over the same exercises (95% bootstrap interval over exercises):')
    lines.append('')
    for i, a in enumerate(models):
        for b in models[i + 1:]:
            d, lo, hi = bootstrap_diff(per_task_rate(done, a), per_task_rate(done, b))
            ta, tb = per_task_rate(done, a), per_task_rate(done, b)
            only_a = sum(1 for t in set(ta) & set(tb) if ta[t] > tb[t])
            only_b = sum(1 for t in set(ta) & set(tb) if tb[t] > ta[t])
            lines.append(f'- {a} − {b}: {d * 100:+.1f} points ({lo * 100:+.1f} to {hi * 100:+.1f}); {a} alone solved {only_a}, {b} alone solved {only_b}')
    errors = [r for r in rows if r['error']]
    if errors:
        lines += ['', f'Runs with an error or timeout (kept in the counts above): {len(errors)}']
        for r in errors[:10]:
            lines.append(f'- {r["model"]} {r["task"]}: {r["error"]}')
    return '\n'.join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--store', required=True)
    ap.add_argument('--out', required=True, type=pathlib.Path)
    ap.add_argument('--models', default='haiku,sonnet,opus')
    ap.add_argument('--effort', default='medium')
    ap.add_argument('--languages', default='python,go')
    ap.add_argument('--n', type=int, default=30, help='exercises to sample (0 = all)')
    ap.add_argument('--seed', type=int, default=20261009)
    ap.add_argument('--repeats', type=int, default=1)
    ap.add_argument('--jobs', type=int, default=6)
    ap.add_argument('--timeout', type=int, default=900)
    ap.add_argument('--max-budget', type=float, default=1.5, help='USD cap per run, enforced by Claude Code')
    ap.add_argument('--max-total', type=float, default=0, help='stop starting runs once the total spend reaches this many USD (0 = no cap)')
    ap.add_argument('--tasks', help='comma-separated lang-slug list; overrides the sample')
    ap.add_argument('--summary-only', action='store_true')
    args = ap.parse_args()

    store = pathlib.Path(args.store).expanduser()
    models = args.models.split(',')
    args.out.mkdir(parents=True, exist_ok=True)
    results = args.out / 'results.jsonl'
    rows = [json.loads(line) for line in results.read_text().splitlines()] if results.exists() else []

    if not args.summary_only:
        tasks = load_tasks(store, args.languages.split(','))
        if args.tasks:
            wanted = set(args.tasks.split(','))
            tasks = [t for t in tasks if f"{t['lang']}-{t['slug']}" in wanted]
        elif args.n and args.n < len(tasks):
            tasks = sorted(random.Random(args.seed).sample(tasks, args.n), key=lambda t: (t['lang'], t['slug']))
        (args.out / 'sample.json').write_text(json.dumps([f"{t['lang']}-{t['slug']}" for t in tasks], indent=1))

        have = {(r['task'], r['model'], r['rep']) for r in rows}
        todo = [(t, m, rep) for t in tasks for m in models for rep in range(args.repeats)
                if (f"{t['lang']}-{t['slug']}", m, rep) not in have]
        workroot = args.out / 'work'
        print(f'{len(tasks)} exercises, {len(todo)} runs to do, {args.jobs} at a time', flush=True)

        def job(item):
            with LOCK:
                if args.max_total and sum(r['cost'] or 0 for r in rows) >= args.max_total:
                    print(f"skipped (spend cap ${args.max_total:.2f} reached): {item[1]} {item[0]['lang']}-{item[0]['slug']}", flush=True)
                    return
            row = run_one(*item[:2], item[2], args, workroot)
            with LOCK:
                with results.open('a') as f:
                    f.write(json.dumps(row) + '\n')
                rows.append(row)
                spent = sum(r['cost'] or 0 for r in rows)
                print(f"{row['model']:7} {row['task']:32} {'PASS' if row['passed'] else 'fail'} ${row['cost'] or 0:.3f} (total ${spent:.2f})", flush=True)

        with ThreadPoolExecutor(args.jobs) as pool:
            list(pool.map(job, todo))

    summary = summarize(rows, models, args.effort)
    (args.out / 'summary.md').write_text(summary + '\n')
    print('\n' + summary)


if __name__ == '__main__':
    main()
