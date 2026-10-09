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


def audit(workdir: pathlib.Path, workroot: pathlib.Path, store: pathlib.Path) -> tuple[int, int]:
    """Places in the transcript that concern the answer key or a sibling run.

    `touched`: in the model's own tool calls (it named or opened them).
    `seen`: only in tool output (a listing showed the path; nothing opened it).
    A run with touched > 0 is excluded and repeated; a run with seen > 0 is
    read by hand, and what the reading found is recorded with the result.
    """
    tdir = transcript_dir(workdir)
    if not tdir.exists():
        return 0, 0
    own = workdir.relative_to(workroot).parts[0]
    pats = [
        re.escape(str(store)), r'polyglot-benchmark', r'tests\.tar',
        # the work root followed by anything but this run's own folder (as a whole name)
        re.escape(str(workroot.resolve())) + r'/(?!' + re.escape(own) + r'(?![A-Za-z0-9_.-]))',
    ]
    touched = seen = 0
    for f in tdir.glob('*.jsonl'):
        for line in f.read_text(errors='ignore').splitlines():
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            content = (d.get('message') or {}).get('content')
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'tool_use':
                    text = json.dumps(b.get('input', {}))
                    touched += sum(len(re.findall(p, text)) for p in pats)
                elif b.get('type') == 'tool_result':
                    c = b.get('content')
                    text = c if isinstance(c, str) else json.dumps(c)
                    seen += sum(len(re.findall(p, text)) for p in pats)
    return touched, seen


def claude_run(workdir: pathlib.Path, prompt: str, model: str, args, cont: bool) -> dict:
    cmd = ['claude', '-p', '--model', model, '--effort', args.effort,
           '--dangerously-skip-permissions', '--output-format', 'json',
           '--max-budget-usd', str(args.max_budget)]
    if cont:
        cmd.append('--continue')
    cmd.append(prompt)
    got = {'cost': None, 'seconds': None, 'turns': None, 'error': None}
    started = time.time()
    try:
        r = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, timeout=args.timeout, stdin=subprocess.DEVNULL)
        got['seconds'] = round(time.time() - started)
        try:
            out = json.loads(r.stdout)
            got['cost'] = out.get('total_cost_usd')
            got['turns'] = out.get('num_turns')
            if out.get('is_error'):
                got['error'] = str(out.get('result', ''))[:200]
        except json.JSONDecodeError:
            got['error'] = f'no json: {r.stderr[-200:]}'
    except subprocess.TimeoutExpired:
        got['seconds'] = args.timeout
        got['error'] = 'timeout'
    return got


def score(task: dict, workdir: pathlib.Path) -> tuple[bool, str]:
    """Put the hidden tests in, run them, and take them out again."""
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
        passed, output = t.returncode == 0, t.stdout + t.stderr
    except subprocess.TimeoutExpired:
        passed, output = False, 'tests timed out'
    for name in task['tests']:
        (workdir / name).unlink(missing_ok=True)
    return passed, output


def feedback(output: str) -> str:
    tail = '\n'.join(output.strip().splitlines()[-60:])
    return ('The hidden unit tests failed. Their output (the tail of it) is below. '
            'You cannot see the test files. Fix your code so they pass, keeping the same file names.\n\n' + tail)


def second_attempt(task: dict, row: dict, output: str, args, workdir: pathlib.Path) -> None:
    got = claude_run(workdir, feedback(output), row['model'], args, cont=True)
    row['cost2'], row['seconds2'], row['turns2'], row['error2'] = got['cost'], got['seconds'], got['turns'], got['error']
    row['passed2'], _ = score(task, workdir)


def finish(task: dict, row: dict, workdir: pathlib.Path, workroot: pathlib.Path, args) -> None:
    row['audit'], row['seen'] = audit(workdir, workroot, pathlib.Path(args.store).expanduser())
    if args.archive and workdir.exists():
        dest = workroot.parent / 'archive' / workdir.relative_to(workroot).parts[0]
        dest.mkdir(parents=True, exist_ok=True)
        shutil.make_archive(str(dest / workdir.name), 'gztar', workdir)
        shutil.rmtree(workdir)


def run_one(task: dict, model: str, rep: int, args, workroot: pathlib.Path) -> dict:
    workdir = workroot / f'{model}-{rep}' / f"{task['lang']}-{task['slug']}"
    if workdir.exists():
        shutil.rmtree(workdir)
    shutil.copytree(pathlib.Path(task['dir']) / 'start', workdir)

    row = {
        'task': f"{task['lang']}-{task['slug']}", 'model': model, 'effort': args.effort, 'rep': rep,
        'passed': False, 'passed2': None, 'cost': None, 'seconds': None, 'turns': None, 'error': None,
        'cost2': None, 'audit': 0, 'seen': 0,
    }
    got = claude_run(workdir, PROMPT.format(files=', '.join(task['solution'])), model, args, cont=False)
    row.update(got)
    row['passed'], output = score(task, workdir)
    if not row['passed'] and args.attempts >= 2:
        second_attempt(task, row, output, args, workdir)
    finish(task, row, workdir, workroot, args)
    return row


def retry_failed(rows: list[dict], tasks_by_name: dict, args, workroot: pathlib.Path) -> None:
    """Second attempts for failed rows that were run with one attempt, then a fresh audit of every row."""
    todo = [r for r in rows if not r['passed'] and r.get('passed2') is None
            and (workroot / f"{r['model']}-{r['rep']}" / r['task']).exists()]

    def one(row):
        task = tasks_by_name[row['task']]
        workdir = workroot / f"{row['model']}-{row['rep']}" / row['task']
        passed, output = score(task, workdir)
        if passed:
            row['passed'] = True
            return
        second_attempt(task, row, output, args, workdir)
        print(f"{row['model']:7} {row['task']:32} attempt 2: {'PASS' if row['passed2'] else 'fail'} ${row['cost2'] or 0:.3f}", flush=True)

    with ThreadPoolExecutor(args.jobs) as pool:
        list(pool.map(one, todo))
    for row in rows:
        workdir = workroot / f"{row['model']}-{row['rep']}" / row['task']
        row['audit'], row['seen'] = audit(workdir, workroot, pathlib.Path(args.store).expanduser())


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


def at2(r: dict) -> bool:
    return bool(r['passed'] or r.get('passed2'))


def summarize(rows: list[dict], models: list[str], effort: str) -> str:
    lines = [f'Exercises scored: {len({r["task"] for r in rows})}. Effort: {effort}.', '']
    lines.append('| Model | Runs | Pass at 1 (95% CI) | Pass at 2 (95% CI) | Mean cost, both attempts | Mean time | Touched | Seen |')
    lines.append('| --- | --: | --- | --- | --: | --: | --: | --: |')
    for m in models:
        mine = [r for r in rows if r['model'] == m]
        if not mine:
            continue
        k1, k2 = sum(r['passed'] for r in mine), sum(at2(r) for r in mine)
        l1, h1 = wilson(k1, len(mine))
        l2, h2 = wilson(k2, len(mine))
        costs = [(r['cost'] or 0) + (r.get('cost2') or 0) for r in mine]
        secs = [(r['seconds'] or 0) + (r.get('seconds2') or 0) for r in mine]
        lines.append(
            f'| {m} | {len(mine)} | {k1}/{len(mine)} = {k1 / len(mine):.0%} ({l1:.0%} to {h1:.0%}) | '
            f'{k2}/{len(mine)} = {k2 / len(mine):.0%} ({l2:.0%} to {h2:.0%}) | ${sum(costs) / len(mine):.3f} | '
            f'{sum(secs) / len(mine):.0f} s | {sum(r["audit"] for r in mine)} | {sum(r.get("seen", 0) for r in mine)} |'
        )
    for label, passed in (('Pass at 1', lambda r: r['passed']), ('Pass at 2', at2)):
        lines += ['', f'{label}: paired difference over the same exercises (95% bootstrap interval; exact sign test on the exercises where only one of the two passed):', '']
        per = {m: {t: float(passed(r)) for r in rows if r['model'] == m for t in [r['task']]} for m in models}
        for i, a in enumerate(models):
            for b in models[i + 1:]:
                d, lo, hi = bootstrap_diff(per[a], per[b])
                shared = set(per[a]) & set(per[b])
                only_a = sum(1 for t in shared if per[a][t] > per[b][t])
                only_b = sum(1 for t in shared if per[b][t] > per[a][t])
                n = only_a + only_b
                p = min(1.0, 2 * sum(math.comb(n, i) for i in range(min(only_a, only_b) + 1)) / 2 ** n) if n else 1.0
                lines.append(f'- {a} − {b}: {d * 100:+.1f} points ({lo * 100:+.1f} to {hi * 100:+.1f}); {a} alone {only_a}, {b} alone {only_b}, exact p = {p:.3f}')
    errors = [r for r in rows if r['error'] or r.get('error2')]
    if errors:
        lines += ['', f'Runs with an error or timeout (kept in the counts above): {len(errors)}']
        for r in errors[:10]:
            lines.append(f'- {r["model"]} {r["task"]}: {r["error"] or r["error2"]}')
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
    ap.add_argument('--attempts', type=int, default=2, choices=[1, 2], help='2 = a second attempt with the failing test output, as Aider does')
    ap.add_argument('--no-archive', dest='archive', action='store_false', help='keep every run folder (default: pack it away after scoring)')
    ap.add_argument('--retry-failed', action='store_true', help='second attempts for failed rows that only had one')
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

    if args.retry_failed:
        every = {f"{t['lang']}-{t['slug']}": t for t in load_tasks(store, args.languages.split(','))}
        retry_failed(rows, every, args, args.out / 'work')
        results.write_text(''.join(json.dumps(r) + '\n' for r in rows))
    elif not args.summary_only:
        tasks = load_tasks(store, args.languages.split(','))
        if args.tasks:
            wanted = set(args.tasks.split(','))
            tasks = [t for t in tasks if f"{t['lang']}-{t['slug']}" in wanted]
        elif args.n and args.n < len(tasks):
            tasks = sorted(random.Random(args.seed).sample(tasks, args.n), key=lambda t: (t['lang'], t['slug']))
        (args.out / 'sample.json').write_text(json.dumps([f"{t['lang']}-{t['slug']}" for t in tasks], indent=1))

        have = {(r['task'], r['model'], r['rep']) for r in rows}
        # Model by model, so the runs in flight at once are different exercises
        # and no finished solution is left lying where a search could find it.
        todo = [(t, m, rep) for m in models for rep in range(args.repeats) for t in tasks
                if (f"{t['lang']}-{t['slug']}", m, rep) not in have]
        workroot = args.out / 'work'
        print(f'{len(tasks)} exercises, {len(todo)} runs to do, {args.jobs} at a time', flush=True)

        def job(item):
            with LOCK:
                if args.max_total and sum((r['cost'] or 0) + (r.get('cost2') or 0) for r in rows) >= args.max_total:
                    print(f"skipped (spend cap ${args.max_total:.2f} reached): {item[1]} {item[0]['lang']}-{item[0]['slug']}", flush=True)
                    return
            row = run_one(*item[:2], item[2], args, workroot)
            with LOCK:
                with results.open('a') as f:
                    f.write(json.dumps(row) + '\n')
                rows.append(row)
                spent = sum((r['cost'] or 0) + (r.get('cost2') or 0) for r in rows)
                second = '' if row['passed2'] is None else f" then {'PASS' if row['passed2'] else 'fail'}"
                print(f"{row['model']:7} {row['task']:32} {'PASS' if row['passed'] else 'fail'}{second} ${(row['cost'] or 0) + (row['cost2'] or 0):.3f} (total ${spent:.2f})", flush=True)

        with ThreadPoolExecutor(args.jobs) as pool:
            list(pool.map(job, todo))

    summary = summarize(rows, models, args.effort)
    (args.out / 'summary.md').write_text(summary + '\n')
    print('\n' + summary)


if __name__ == '__main__':
    main()
