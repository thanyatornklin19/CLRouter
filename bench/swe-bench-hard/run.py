#!/usr/bin/env python3
"""Runs Claude Code on hard SWE-bench Verified tasks and grades it with the official harness.

    python3 run.py --store STORE --out OUT --harness-python VENV/bin/python \\
        --arms haiku:high,sonnet:medium,opus:high --max-total 50

Tasks are taken in the order of pool.json (a seeded random permutation). For each:

  1. The official SWE-bench image is pulled through mirror.gcr.io (Docker Hub
     rate-limits this environment) and tagged with the name the harness expects.
  2. The image is checked: its /testbed must sit at the task's base commit, and
     no commit after it may be in the repository, reachable or not. Agents have
     been caught reading the fix out of `git log --all`.
  3. The reference fix is graded by the official harness, and so is a patch
     that changes nothing the tests can see. A task is skipped, before any
     model runs, unless the first passes and the second fails.
  4. Each arm runs in turn, never two arms of one task at once. /testbed is
     copied to a fresh folder, the image is started as a container with no
     network and that folder mounted, and Claude Code works in the folder.
     `python`, `pytest`, `pip` and `timeout` are shims that run inside the container, so
     the model tests in the environment the grader uses. Claude Code runs
     restricted: tools Bash, Read, Edit, Write, Glob and Grep; edits only inside
     the folder; shell commands only from ALLOWED_BASH, everything else refused.
  5. The model's patch (everything it changed, as `git diff`) is graded by the
     official harness, unchanged: the hidden tests are applied over it and the
     task's FAIL_TO_PASS and PASS_TO_PASS tests must all pass.

Every run folder is archived when its run ends and every grading log (they
hold the hidden tests) is archived when it is read, so nothing a later run
could use is left lying around. Transcripts are audited as in ../PROTOCOL.md.
Results are appended to <out>/results.jsonl; an interrupted run resumes.
"""
import argparse
import gzip
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from stats import bootstrap_diff, sign_test, wilson  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
HARNESS_PY = pathlib.Path(os.environ.get('SWEBENCH_PYTHON', 'python3'))  # an interpreter with swebench==4.1.0; see --harness-python
MIRROR = 'mirror.gcr.io/'
ENV_BIN = '/opt/miniconda3/envs/testbed/bin'
CONTAINER_PATH = f'{ENV_BIN}:/opt/miniconda3/condabin:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

# Anthropic's published SWE-bench prompt (Claude 3.5 Sonnet, October 2024),
# with the location filled in and the last paragraph added for this setup.
PROMPT = """<uploaded_files>
{location}
</uploaded_files>
I've uploaded a python code repository in the directory {location}. Consider the following PR description:

<pr_description>
{issue}
</pr_description>

Can you help me implement the necessary changes to the repository so that the requirements specified in the <pr_description> are met?
I've already taken care of all changes to any of the test files described in the <pr_description>. This means you DON'T have to modify the testing logic or any of the tests in any way!

Your task is to make the minimal changes to non-tests files in the {location} directory to ensure the <pr_description> is satisfied.

Follow these steps to resolve the issue:
1. As a first step, it might be a good idea to explore the repo to familiarize yourself with its structure.
2. Create a script to reproduce the error and execute it with `python <filename.py>` using the BashTool, to confirm the error
3. Edit the sourcecode of the repo to resolve the issue
4. Rerun your reproduce script and confirm that the error is fixed!
5. Think about edgecases and make sure your fix handles them as well

Your thinking should be thorough and so it's fine if it's very long.

The repository's Python environment is installed: `python`, `pytest` and the project's own test runner work from the shell. There is no network access."""

TOOLS = 'Bash,Edit,Read,Write,Glob,Grep'
ALLOWED_BASH = [f'Bash({c}:*)' for c in (
    'python', 'python3', 'pytest', 'py.test', './tests/runtests.py', 'tests/runtests.py', 'bin/test', './bin/test', 'timeout',
    'cd', 'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'sort', 'uniq', 'diff', 'which', 'tree', 'file',
    'stat', 'pwd', 'echo', 'printf', 'sed -n',
    'git status', 'git diff', 'git log', 'git show', 'git grep', 'git blame', 'git ls-files', 'git rev-parse', 'git checkout',
)]

VERSION_CODE = {
    'django/django': "import django; print('%d.%d' % django.VERSION[:2])",
    'sympy/sympy': "import sympy; print('.'.join(sympy.__version__.split('.')[:2]))",
}

NULL_PATCH = """diff --git a/CLROUTER_NULL_CHECK.txt b/CLROUTER_NULL_CHECK.txt
new file mode 100644
--- /dev/null
+++ b/CLROUTER_NULL_CHECK.txt
@@ -0,0 +1 @@
+This patch changes nothing the tests can see.
"""

LOCK = threading.Lock()


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def image(iid: str) -> str:
    return f"swebench/sweb.eval.x86_64.{iid.lower().replace('__', '_1776_')}:latest"


def pull(iid: str) -> None:
    name = image(iid)
    if sh(['docker', 'image', 'inspect', name]).returncode == 0:
        return
    for _ in range(3):
        r = sh(['docker', 'pull', '-q', MIRROR + name], timeout=3600)
        if r.returncode == 0:
            sh(['docker', 'tag', MIRROR + name, name], check=True)
            return
        time.sleep(60)
    raise RuntimeError(f'pull failed for {iid}: {r.stderr.strip()[-300:]}')


def drop_image(iid: str) -> None:
    sh(['docker', 'rmi', '-f', image(iid), MIRROR + image(iid)])


def specs(repo: str, version: str) -> dict | None:
    code = ('import json,sys; from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS as M; '
            'print(json.dumps(M.get(sys.argv[1], {}).get(sys.argv[2])))')
    return json.loads(sh([str(HARNESS_PY), '-c', code, repo, version], check=True).stdout)


def template(task: dict, out: pathlib.Path) -> dict:
    """Copy /testbed out of the image and check its history ends at the base commit."""
    iid = task['instance_id']
    t = out / 'templates' / iid
    if t.exists():
        shutil.rmtree(t)
    t.parent.mkdir(parents=True, exist_ok=True)
    cid = sh(['docker', 'create', image(iid)], check=True).stdout.strip()
    try:
        sh(['docker', 'cp', f'{cid}:/testbed', str(t)], check=True)
    finally:
        sh(['docker', 'rm', '-f', cid])

    def git(*a: str) -> str:
        return sh(['git', '-C', str(t), *a]).stdout.strip()

    def unreachable() -> int:
        return sum(1 for line in git('fsck', '--unreachable', '--no-reflogs', '--no-progress').splitlines()
                   if line.startswith('unreachable commit'))

    # Images rebuilt in 2026 add one empty commit ("SWE-bench") on top of the
    # base commit. That is accepted only when its parent is the base commit and
    # its tree is the base commit's tree.
    base, head = task['base_commit'], git('rev-parse', 'HEAD')
    info = {
        'head_ok': head == base or (git('rev-parse', 'HEAD^') == base
                                    and git('rev-parse', 'HEAD^{tree}') == git('rev-parse', base + '^{tree}')),
        'marker_commit': head != base,
        'later_commits': int(git('rev-list', '--all', '--count') or 0) - int(git('rev-list', 'HEAD', '--count') or 0),
        'unreachable_commits': unreachable(),
        'pruned': False,
    }
    if info['later_commits'] or info['unreachable_commits']:
        for ref in git('for-each-ref', '--format=%(refname)').split():
            if ref != git('symbolic-ref', '-q', 'HEAD'):
                git('update-ref', '-d', ref)
        git('reflog', 'expire', '--expire=now', '--all')
        git('gc', '--prune=now', '--quiet')
        info['pruned'] = True
        info['left_after_prune'] = unreachable() + int(git('rev-list', '--all', '--count') or 0) - int(git('rev-list', 'HEAD', '--count') or 0)
    info['version'] = sh(['docker', 'run', '--rm', '--network', 'none', '-w', '/testbed', image(iid),
                          f'{ENV_BIN}/python', '-c', VERSION_CODE[task['repo']]]).stdout.strip()
    return info


def grade(task: dict, version: str, label: str, patch: str, out: pathlib.Path) -> dict:
    """Grade one patch with the official harness; archive its logs, which hold the hidden tests."""
    iid = task['instance_id']
    gdir = out / 'grading'
    run_id = f'{label}.{iid}'
    tmp = gdir / 'tmp' / run_id
    tmp.mkdir(parents=True, exist_ok=True)
    got = {'resolved': False, 'grade_error': None, 'f2p': None, 'p2p': None}
    if not patch.strip():
        got['grade_error'] = 'empty patch'
        shutil.rmtree(tmp, ignore_errors=True)
        return got
    # The reference fix never goes in the dataset file; a prediction carries the patch.
    (tmp / 'dataset.json').write_text(json.dumps([{**task, 'version': version, 'patch': ''}]))
    (tmp / 'preds.jsonl').write_text(json.dumps({'instance_id': iid, 'model_name_or_path': label, 'model_patch': patch}) + '\n')
    r = sh([str(HARNESS_PY), '-m', 'swebench.harness.run_evaluation',
            '--dataset_name', str(tmp / 'dataset.json'), '--predictions_path', str(tmp / 'preds.jsonl'),
            '--instance_ids', iid, '--max_workers', '1', '--run_id', run_id, '--namespace', 'swebench',
            '--cache_level', 'instance', '--report_dir', str(tmp), '--timeout', '1800'], cwd=gdir, timeout=4000)
    logs = gdir / 'logs' / 'run_evaluation' / run_id
    report = logs / label / iid / 'report.json'
    if report.exists():
        rep = json.loads(report.read_text())[iid]
        got['resolved'] = bool(rep.get('resolved'))
        status = rep.get('tests_status', {})
        for key, name in (('f2p', 'FAIL_TO_PASS'), ('p2p', 'PASS_TO_PASS')):
            s = status.get(name, {})
            got[key] = f"{len(s.get('success', []))}/{len(s.get('success', [])) + len(s.get('failure', []))}"
    else:
        log = logs / label / iid / 'run_instance.log'
        tail = log.read_text(errors='ignore')[-400:] if log.exists() else (r.stdout + r.stderr)[-400:]
        got['grade_error'] = 'no report: ' + tail.replace('\n', ' ')
    if logs.exists():
        dest = out / 'archive' / 'grading'
        dest.mkdir(parents=True, exist_ok=True)
        shutil.make_archive(str(dest / run_id), 'gztar', logs)
        shutil.rmtree(logs)
    shutil.rmtree(tmp, ignore_errors=True)
    return got


def make_shims(shims: pathlib.Path, work: pathlib.Path, scratch: pathlib.Path, container: str, exports: dict[str, str]) -> None:
    shims.mkdir(parents=True, exist_ok=True)
    env = ' '.join(f'-e {k}={v}' for k, v in {'PATH': CONTAINER_PATH, 'CONDA_PREFIX': ENV_BIN[:-4],
                                               'CONDA_DEFAULT_ENV': 'testbed', **exports}.items())
    targets = {f'python{v}': f'{ENV_BIN}/python' for v in ['', '3'] + [f'3.{m}' for m in range(5, 14)]}
    targets.update({'pytest': f'{ENV_BIN}/python -m pytest', 'py.test': f'{ENV_BIN}/python -m pytest',
                    'pip': f'{ENV_BIN}/python -m pip', 'pip3': f'{ENV_BIN}/python -m pip',
                    # Whatever `timeout` wraps runs in the container too, so allowing it opens nothing.
                    'timeout': 'timeout'})
    for name, target in targets.items():
        p = shims / name
        p.write_text(
            '#!/bin/bash\n'
            '# Runs inside the task container (no network; only this run\'s folder and scratchpad are mounted).\n'
            f'case "$PWD/" in "{work}/"*|"{scratch}/"*) d="$PWD" ;; *) d="{work}" ;; esac\n'
            f'exec docker exec -i -w "$d" {env} {container} {target} "$@"\n'
        )
        p.chmod(0o755)


def transcript_dir(work: pathlib.Path) -> pathlib.Path:
    return pathlib.Path.home() / '.claude' / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', str(work.resolve()))


NET = re.compile(r'\b(curl|wget|nc|ssh|scp|rsync|docker)\b|\bgit\s+(fetch|clone|pull|remote|ls-remote|submodule)\b'
                 r'|\bpip3?\s+(install|download)\b|https?://')


def audit(work: pathlib.Path, shims: pathlib.Path, out: pathlib.Path, store: pathlib.Path) -> dict:
    """Count places in the transcript that concern answers, other runs or the network (see ../PROTOCOL.md rule 5).

    `touched`: the model's own tool calls name the store, the dataset copy, the
    grader or another run's folder. `seen`: only a tool's output showed them.
    `net`: shell commands that would reach the network or Docker.
    """
    root = re.escape(str(out.resolve()))
    own = '|'.join(re.escape(str(p.relative_to(out))) + r'(?![A-Za-z0-9_.-])' for p in (work, shims))
    pats = [re.escape(str(store)), r'\.bench-src', r'moatless', r'tasks\.json', r'run_evaluation', root + r'/(?!' + own + ')']
    got = {'touched': 0, 'seen': 0, 'net': 0}
    tdir = transcript_dir(work)
    if not tdir.exists():
        return got
    for f in tdir.glob('*.jsonl'):
        for line in f.read_text(errors='ignore').splitlines():
            try:
                content = (json.loads(line).get('message') or {}).get('content')
            except (json.JSONDecodeError, AttributeError):
                continue
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'tool_use':
                    text = json.dumps(b.get('input', {}))
                    got['touched'] += sum(len(re.findall(p, text)) for p in pats)
                    if b.get('name') == 'Bash':
                        got['net'] += len(NET.findall(str(b.get('input', {}).get('command', ''))))
                elif b.get('type') == 'tool_result':
                    c = b.get('content')
                    text = c if isinstance(c, str) else json.dumps(c)
                    got['seen'] += sum(len(re.findall(p, text)) for p in pats)
    return got


def run_agent(task: dict, arm: dict, rep: int, tinfo: dict, env_setup: tuple, out: pathlib.Path, args) -> tuple[dict, str]:
    iid = task['instance_id']
    name = f"{iid}.{arm['label']}.{rep}"
    work = out / 'work' / name
    shims = out / 'shims' / name
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(out / 'templates' / iid, work, symlinks=True)
    container = 'clr-' + re.sub(r'[^A-Za-z0-9_.-]', '-', name)
    # Claude Code gives each session a scratchpad under its temp folder and
    # tells the model to use it; mount it so scripts kept there run too.
    scratch = pathlib.Path(os.environ.get('CLAUDE_CODE_TMPDIR') or f'/tmp/claude-{os.getuid()}') / re.sub(r'[^A-Za-z0-9]', '-', str(work))
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)
    sh(['docker', 'rm', '-f', container])
    sh(['docker', 'run', '-d', '--rm', '--network', 'none', '--name', container,
        '-v', f'{work}:/testbed', '-v', f'{work}:{work}', '-v', f'{scratch}:{scratch}',
        image(iid), 'tail', '-f', '/dev/null'], check=True)
    exports, setup = env_setup
    for c in setup:
        sh(['docker', 'exec', container, 'bash', '-c', c])
    make_shims(shims, work, scratch, container, exports)

    row = {
        'task': iid, 'repo': task['repo'], 'version': tinfo['version'], 'arm': arm['label'], 'model': arm['model'],
        'effort': arm['effort'], 'rep': rep, 'resolved': False, 'cost': None, 'seconds': None, 'turns': None,
        'error': None, 'model_ids': [], 'denied': 0, 'denied_cmds': [],
    }
    env = {k: v for k, v in os.environ.items()
           if k not in ('CLAUDE_ADDITIONAL_DIRECTORIES', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD')}
    env['PATH'] = f"{shims}:{env['PATH']}"
    cmd = ['claude', '-p', '--model', arm['model'], '--effort', arm['effort'], '--permission-mode', 'acceptEdits',
           '--strict-mcp-config', '--tools', TOOLS, '--max-budget-usd', str(args.max_budget),
           '--output-format', 'json', '--allowedTools', *ALLOWED_BASH]
    started = time.time()
    try:
        r = subprocess.run(cmd, input=PROMPT.format(location=work, issue=task['problem_statement']), cwd=work, env=env,
                           capture_output=True, text=True, timeout=args.timeout)
        row['seconds'] = round(time.time() - started)
        try:
            res = json.loads(r.stdout)
            row['cost'] = res.get('total_cost_usd')
            row['turns'] = res.get('num_turns')
            row['model_ids'] = sorted((res.get('modelUsage') or {}).keys())
            denials = res.get('permission_denials') or []
            row['denied'] = len(denials)
            row['denied_cmds'] = [str((d.get('tool_input') or {}).get('command', d.get('tool_name')))[:100] for d in denials[:20]]
            if res.get('is_error'):
                row['error'] = str(res.get('result') or res.get('subtype'))[:200]
        except json.JSONDecodeError:
            row['error'] = f'no json: {r.stderr[-200:]}'
    except subprocess.TimeoutExpired:
        row['seconds'] = args.timeout
        row['error'] = 'timeout'
    finally:
        sh(['docker', 'rm', '-f', container])

    sh(['git', '-C', str(work), 'add', '-A', '--', '.', ':!.claude'])
    patch = sh(['git', '-C', str(work), 'diff', '--cached', '--binary', task['base_commit']]).stdout
    row['patch_files'] = sh(['git', '-C', str(work), 'diff', '--cached', '--name-only', task['base_commit']]).stdout.split()
    row['patch_lines'] = sum(1 for line in patch.splitlines() if line[:1] in '+-' and line[:3] not in ('+++', '---'))
    row.update(audit(work, shims, out, pathlib.Path(args.store).expanduser()))

    # Keep the patch and the transcript; the rest of the folder is the image's /testbed again.
    pdir = out / 'patches'
    pdir.mkdir(parents=True, exist_ok=True)
    with gzip.open(pdir / f'{name}.diff.gz', 'wt') as f:
        f.write(patch)
    if transcript_dir(work).exists():
        shutil.copytree(transcript_dir(work), out / 'transcripts' / name, dirs_exist_ok=True)
    if not args.keep_work:
        shutil.rmtree(work)
    shutil.rmtree(shims, ignore_errors=True)
    shutil.rmtree(scratch, ignore_errors=True)
    return row, patch


def env_setup(spec: dict) -> tuple[dict, list[str]]:
    """The harness's eval_commands, split into environment variables and one-off setup commands."""
    exports, setup = {}, []
    for c in spec.get('eval_commands', []):
        m = re.fullmatch(r'export (\w+)=(\S+)', c.strip())
        if m:
            exports[m.group(1)] = m.group(2)
        elif not c.startswith(('source ', 'conda ', 'cd ')):
            setup.append(c)
    return exports, setup


def spent(rows: list[dict]) -> float:
    return sum(r['cost'] or 0 for r in rows)


def do_task(task: dict, arms: list[dict], out: pathlib.Path, args, rows: list[dict], gold: dict, state: dict) -> None:
    iid = task['instance_id']
    have = {(r['task'], r['arm'], r['rep']) for r in rows}
    todo = [(a, rep) for a in arms for rep in range(args.repeats) if (iid, a['label'], rep) not in have]
    if not todo or (iid in gold and (args.gold_only or not gold[iid]['ok'])):
        return
    with LOCK:
        if args.gold_only:
            state['reserved'][iid] = 0
        else:
            done = {r['task'] for r in rows}
            per_task = (spent(rows) / len(done)) if done else args.task_estimate
            if state['stopped'] or (args.max_total and spent(rows) + sum(state['reserved'].values()) + per_task > args.max_total):
                state['stopped'] = True
                print(f'not started (budget): {iid}', flush=True)
                return
            state['reserved'][iid] = per_task
    try:
        while shutil.disk_usage(out).free < args.min_free_gb * 1e9:
            time.sleep(30)
        pull(iid)
        tinfo = template(task, out)
        spec = specs(task['repo'], tinfo['version'])
        if iid not in gold:
            ok = tinfo['head_ok'] and spec is not None and not tinfo.get('left_after_prune')
            g = grade(task, tinfo['version'], 'gold', task['patch'], out) if ok else {'resolved': False, 'grade_error': 'image check failed'}
            # A patch that changes nothing the tests can see must not pass, or the grader proves nothing.
            null = grade(task, tinfo['version'], 'null', NULL_PATCH, out)['resolved'] if g['resolved'] else None
            gold[iid] = {'task': iid, 'ok': bool(ok and g['resolved'] and null is False), **tinfo, **g, 'null_resolved': null}
            with LOCK, (out / 'gold.jsonl').open('a') as f:
                f.write(json.dumps(gold[iid]) + '\n')
            print(f"gold    {iid:30} {'ok' if gold[iid]['ok'] else 'EXCLUDED'} v{tinfo['version']} {g.get('f2p')} {g.get('p2p')} "
                  f"null patch {'not run' if null is None else 'RESOLVED' if null else 'fails'} {g.get('grade_error') or ''}", flush=True)
            if not gold[iid]['ok'] or args.gold_only:
                return
        for arm, rep in todo:
            row, patch = run_agent(task, arm, rep, tinfo, env_setup(spec), out, args)
            row.update(grade(task, tinfo['version'], f"{arm['label']}-r{rep}", patch, out))
            with LOCK:
                with (out / 'results.jsonl').open('a') as f:
                    f.write(json.dumps(row) + '\n')
                rows.append(row)
                print(f"{arm['label']:14} {iid:30} {'RESOLVED' if row['resolved'] else 'fail':8} ${row['cost'] or 0:.2f} "
                      f"{row['seconds']}s f2p {row['f2p']} p2p {row['p2p']} denied {row['denied']} "
                      f"audit {row['touched']}/{row['seen']}/{row['net']} {row['error'] or row['grade_error'] or ''} "
                      f"(total ${spent(rows):.2f})", flush=True)
    except Exception as e:  # noqa: BLE001 - one task's infrastructure failure must not stop the rest
        print(f'ERROR   {iid}: {e}', flush=True)
    finally:
        if args.clean_images:
            drop_image(iid)
        shutil.rmtree(out / 'templates' / iid, ignore_errors=True)
        with LOCK:
            state['reserved'].pop(iid, None)


def routes(tasks: list[dict]) -> dict:
    issues = json.dumps({t['instance_id']: t['problem_statement'] for t in tasks})
    r = sh(['node', '--experimental-strip-types', '--no-warnings', str(HERE / 'route.mjs')], input=issues, check=True)
    return json.loads(r.stdout)


def added_lines(patch: str) -> list[str]:
    return [line[1:].strip() for line in patch.splitlines()
            if line.startswith('+') and not line.startswith('+++') and line[1:].strip()]


def recall(upstream: str, model: str) -> tuple[float, int, int]:
    """How much of the maintainers' fix the model wrote word for word.

    Returns the share of the fix's added lines found verbatim among the
    model's added lines, and how many of the fix's added comment lines (five
    or more words) the model reproduced, out of how many there are. Tests
    can't make a model word a comment the same way, so a verbatim comment
    points to memory of the fix rather than to working it out.
    """
    fix, mine = added_lines(upstream), set(added_lines(model))
    comments = [line for line in fix if line.startswith('#') and len(line.split()) >= 6]
    share = sum(line in mine for line in fix) / len(fix) if fix else 0.0
    return share, sum(c in mine for c in comments), len(comments)


def summarize(rows: list[dict], gold: dict, arms: list[dict], verdicts: dict, tasks: dict, out: pathlib.Path) -> str:
    labels = [a['label'] for a in arms]
    complete = sorted(t for t in {r['task'] for r in rows} if all(any(r['task'] == t and r['arm'] == a for r in rows) for a in labels))
    rows = [r for r in rows if r['task'] in complete]
    excluded = sorted(t for t, g in gold.items() if not g['ok'])
    lines = [f'Tasks graded on every arm: {len(complete)}. Excluded before any model ran (image check or grader controls failed): {len(excluded)}'
             + (f" ({', '.join(excluded)})" if excluded else '') + '.', '',
             '| Arm | Runs | Resolved (95% CI) | Mean cost | Cost per resolved | Mean time | Errors | Denied cmds | Touched | Seen | Net |',
             '| --- | --: | --- | --: | --: | --: | --: | --: | --: | --: | --: |']
    per = {}
    for a in labels:
        mine = [r for r in rows if r['arm'] == a]
        if not mine:
            continue
        k, n = sum(r['resolved'] for r in mine), len(mine)
        lo, hi = wilson(k, n)
        cost = sum(r['cost'] or 0 for r in mine)
        per[a] = {t: sum(r['resolved'] for r in mine if r['task'] == t) / sum(1 for r in mine if r['task'] == t) for t in complete}
        lines.append(f"| {a} | {n} | {k}/{n} = {k / n:.0%} ({lo:.0%} to {hi:.0%}) | ${cost / n:.2f} | "
                     f"{'$%.2f' % (cost / k) if k else 'n/a'} | {sum(r['seconds'] or 0 for r in mine) / n / 60:.1f} min | "
                     f"{sum(1 for r in mine if r['error'] or r['grade_error'])} | {sum(r['denied'] for r in mine)} | "
                     f"{sum(r['touched'] for r in mine)} | {sum(r['seen'] for r in mine)} | {sum(r['net'] for r in mine)} |")
    lines += ['', 'Paired difference over the same tasks (95% bootstrap interval; exact sign test on tasks only one arm resolved):', '']
    for i, a in enumerate(labels):
        for b in labels[i + 1:]:
            if a in per and b in per:
                d, lo, hi = bootstrap_diff(per[a], per[b])
                only_a = sum(1 for t in complete if per[a][t] > per[b][t])
                only_b = sum(1 for t in complete if per[b][t] > per[a][t])
                lines.append(f'- {a} − {b}: {d * 100:+.1f} points ({lo * 100:+.1f} to {hi * 100:+.1f}); '
                             f'{a} alone {only_a}, {b} alone {only_b}, exact p = {sign_test(only_a, only_b):.3f}')

    cost = {(r['task'], r['arm']): r['cost'] or 0 for r in rows}
    by_tier = {a['model']: a['label'] for a in arms}
    lines += ['', "Router lookup (keyword router on each issue's text; no extra runs):", '']
    picks = {t: verdicts.get(t) for t in complete}
    tally: dict[str, int] = {}
    for v in picks.values():
        key = 'abstains' if v is None else f"{v['tier']} ({v['kind']}, {v['confidence']} confidence)"
        tally[key] = tally.get(key, 0) + 1
    lines.append('- Verdicts: ' + ', '.join(f'{k}: {n}' for k, n in sorted(tally.items())))
    for session in ('opus', 'sonnet'):
        if session not in by_tier:
            continue
        chosen = {}
        for t, v in picks.items():
            tier = v['tier'] if v and v['confidence'] == 'high' and v['tier'] in by_tier else session
            chosen[t] = by_tier[tier]
        k = sum(per[chosen[t]][t] for t in complete)
        c = sum(cost[(t, chosen[t])] for t in complete)
        lines.append(f'- From a {session} session: resolves {k:.0f}/{len(complete)}, ${c / max(1, len(complete)):.2f} per task')
    best = {t: min((cost[(t, a)], a) for a in labels if per[a][t] > 0) if any(per[a][t] > 0 for a in labels) else None for t in complete}
    solved = [b for b in best.values() if b]
    lines.append(f'- Cheapest arm that resolved each task (no router can beat this): {len(solved)}/{len(complete)}, '
                 f'${sum(b[0] for b in solved) / max(1, len(complete)):.2f} per task (unresolved tasks counted at $0)')

    lines += ['', "Recall of the maintainers' fix (verbatim lines in the model's patch):", '']
    for a in labels:
        got = []
        for r in (r for r in rows if r['arm'] == a):
            pf = out / 'patches' / f"{r['task']}.{a}.{r['rep']}.diff.gz"
            if pf.exists():
                with gzip.open(pf, 'rt') as f:
                    got.append((r['resolved'], *recall(tasks[r['task']]['patch'], f.read())))
        if got:
            with_comments = [g for g in got if g[3]]
            lines.append(f"- {a}: {sum(g[1] for g in got) / len(got):.0%} of the fix's added lines on average; "
                         f"reproduced at least one of the fix's comments word for word in {sum(1 for g in with_comments if g[2])} "
                         f"of the {len(with_comments)} runs whose fix adds a comment")

    errors = [r for r in rows if r['error'] or r['grade_error']]
    if errors:
        lines += ['', f'Runs with an error (kept in the counts): {len(errors)}']
        lines += [f"- {r['arm']} {r['task']}: {r['error'] or r['grade_error']}" for r in errors[:15]]
    ids = sorted({m for r in rows for m in r.get('model_ids', [])})
    lines += ['', f'Model ids reported by Claude Code: {", ".join(ids)}']
    return '\n'.join(lines)


def main() -> None:
    global HARNESS_PY
    ap = argparse.ArgumentParser()
    ap.add_argument('--store', required=True)
    ap.add_argument('--harness-python', type=pathlib.Path, default=HARNESS_PY, help='Python with swebench==4.1.0 installed')
    ap.add_argument('--out', required=True, type=pathlib.Path)
    ap.add_argument('--arms', default='haiku:high,sonnet:medium,opus:high', help='model:effort, comma-separated')
    ap.add_argument('--tasks', help='comma-separated instance ids; overrides the pool order')
    ap.add_argument('--n', type=int, default=0, help='start at most this many tasks from the pool order (0 = no limit)')
    ap.add_argument('--repeats', type=int, default=1)
    ap.add_argument('--jobs', type=int, default=3, help='tasks in flight at once (arms of one task never overlap)')
    ap.add_argument('--timeout', type=int, default=3600)
    ap.add_argument('--max-budget', type=float, default=5.0, help='USD cap per run, enforced by Claude Code')
    ap.add_argument('--max-total', type=float, default=0, help='stop starting tasks once spend plus reserved estimates would pass this (0 = no cap)')
    ap.add_argument('--task-estimate', type=float, default=4.0, help='USD reserved per task until real costs are known')
    ap.add_argument('--min-free-gb', type=float, default=7.0)
    ap.add_argument('--keep-images', dest='clean_images', action='store_false')
    ap.add_argument('--keep-work', action='store_true', help="keep each run's folder (default: delete it once its patch is saved)")
    ap.add_argument('--summary-only', action='store_true')
    ap.add_argument('--gold-only', action='store_true', help='only check images and grade the reference fixes; no model runs')
    args = ap.parse_args()
    HARNESS_PY = args.harness_python

    out = args.out.expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / 'grading').mkdir(exist_ok=True)
    with gzip.open(pathlib.Path(args.store).expanduser() / 'tasks.json.gz', 'rt') as f:
        tasks = {t['instance_id']: t for t in json.load(f)}
    pool = json.loads((HERE / 'pool.json').read_text())
    order = args.tasks.split(',') if args.tasks else pool['order']
    if args.n:
        order = order[:args.n]
    arms = [{'model': m, 'effort': e, 'label': f'{m}-{e}'} for m, e in (a.split(':') for a in args.arms.split(','))]

    rows = [json.loads(line) for line in (out / 'results.jsonl').read_text().splitlines()] if (out / 'results.jsonl').exists() else []
    gold = {}
    if (out / 'gold.jsonl').exists():
        for line in (out / 'gold.jsonl').read_text().splitlines():
            g = json.loads(line)
            gold[g['task']] = g

    if not args.summary_only:
        (out / 'order.json').write_text(json.dumps(order, indent=1))
        state = {'stopped': False, 'reserved': {}}
        print(f"{len(order)} tasks in order, arms {[a['label'] for a in arms]}, {args.jobs} tasks at a time", flush=True)
        with ThreadPoolExecutor(args.jobs) as pool_:
            list(pool_.map(lambda iid: do_task(tasks[iid], arms, out, args, rows, gold, state), order))

    summary = summarize(rows, gold, arms, routes([tasks[t] for t in {r['task'] for r in rows}]), tasks, out)
    (out / 'summary.md').write_text(summary + '\n')
    print('\n' + summary)


if __name__ == '__main__':
    main()
