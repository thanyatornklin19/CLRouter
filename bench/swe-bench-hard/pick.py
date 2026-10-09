#!/usr/bin/env python3
"""Picks the hard SWE-bench Verified tasks and packs them into a store.

SWE-bench Verified is 500 real GitHub issues from 12 Python repositories, each
with the fix the maintainers merged and the tests that came with it, screened
by human annotators for a clear issue and fair tests. The usual source is
Hugging Face, which the environment this was built in cannot reach, so the
tasks come from the copy in aorwall/moatless-tools
(`moatless/evaluation/swebench_verified_all_evaluations.json`). That file also
records, for every task, which of 35 leaderboard submissions (October 2023 to
October 2024) resolved it.

The copy is checked as it is used: `run.py` refuses a task unless the official
SWE-bench image's repository sits at the task's base commit and the official
harness passes the reference fix. A copy that disagreed with the real dataset
on either would show there.

The rule, fixed before any model ran:

  - repositories django/django and sympy/sympy (306 of the 500);
  - resolved by at least 1 and at most 5 of the 35 submissions: hard, but
    shown to be solvable from the issue text. 71 tasks.
  - run in the order of a random permutation (seed 20261009). A run stops
    starting tasks when its budget is spent, so the tasks run are a random
    sample of the pool.

Writes:
  <store>/tasks.json.gz   what the grader needs, including the reference fix
                          and the hidden tests. Gzipped so that a text search
                          from inside a run can't land on an answer.
  pool.json               (next to this file) the ids, solve counts and order.
                          No answers.

    git clone --depth 1 https://github.com/aorwall/moatless-tools SRC
    python3 pick.py --src SRC/moatless/evaluation/swebench_verified_all_evaluations.json \\
        --store ~/.bench-store/swebench-hard
    rm -rf SRC        # the copy holds the answers
"""
import argparse
import gzip
import hashlib
import json
import pathlib
import random

REPOS = ('django/django', 'sympy/sympy')
MIN_SOLVED, MAX_SOLVED = 1, 5
SEED = 20261009
HERE = pathlib.Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, type=pathlib.Path)
    ap.add_argument('--source-commit', default='011ead57a5c81664e9c45e07e1f50b17e695cc63',
                    help='moatless-tools commit the file came from, recorded in pool.json')
    ap.add_argument('--store', required=True, type=pathlib.Path)
    args = ap.parse_args()

    raw = args.src.read_bytes()
    every = json.loads(raw)
    submissions = sorted({s['name'] for t in every for s in t['resolved_by']})
    pool = [t for t in every if t['repo'] in REPOS and MIN_SOLVED <= len(t['resolved_by']) <= MAX_SOLVED]
    pool.sort(key=lambda t: t['instance_id'])
    order = [t['instance_id'] for t in pool]
    random.Random(SEED).shuffle(order)

    args.store.mkdir(parents=True, exist_ok=True)
    tasks = [{
        'instance_id': t['instance_id'],
        'repo': t['repo'],
        'base_commit': t['base_commit'],
        'problem_statement': t['problem_statement'],
        'patch': t['golden_patch'],
        'test_patch': t['test_patch'],
        'FAIL_TO_PASS': t['fail_to_pass'],
        'PASS_TO_PASS': t['pass_to_pass'],
        'hints_text': '',
        'created_at': '',
    } for t in pool]
    with gzip.open(args.store / 'tasks.json.gz', 'wt') as f:
        json.dump(tasks, f)

    (HERE / 'pool.json').write_text(json.dumps({
        'source': {
            'repository': 'https://github.com/aorwall/moatless-tools',
            'commit': args.source_commit,
            'file': 'moatless/evaluation/swebench_verified_all_evaluations.json',
            'sha256': hashlib.sha256(raw).hexdigest(),
            'tasks_in_file': len(every),
        },
        'rule': {
            'repos': list(REPOS),
            'resolved_by_at_least': MIN_SOLVED,
            'resolved_by_at_most': MAX_SOLVED,
            'of_submissions': len(submissions),
            'seed': SEED,
        },
        'submissions': submissions,
        'order': order,
        'tasks': {t['instance_id']: {'repo': t['repo'], 'resolved_by': len(t['resolved_by'])} for t in pool},
    }, indent=1) + '\n')

    by_repo = {r: sum(t['repo'] == r for t in pool) for r in REPOS}
    print(f'{len(pool)} tasks in the pool {by_repo}, from {len(every)} in the file and {len(submissions)} submissions')


if __name__ == '__main__':
    main()
