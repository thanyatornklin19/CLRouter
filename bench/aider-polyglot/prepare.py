#!/usr/bin/env python3
"""Packs Aider's polyglot-benchmark exercises into a clean store.

The exercise folders ship with the answer: `.meta/example.*` is a reference
solution and `.approaches/` explains several. A model that can read them
isn't being tested. So for every exercise this builds, in the store:

  start/       what the model sees: the stub files, support code and an
               INSTRUCTIONS.md. No tests, no .meta, no .approaches.
  tests.tar    the hidden test files, kept outside anything the model gets.
  spec.json    the solution files, the test files and `reference_ok`.

`reference_ok` is true when the exercise's own reference solution passes the
hidden tests as this harness runs them. Exercises where it doesn't (a missing
dependency, a toolchain quirk) are left out of every sample, so a failure in a
run means the model's code failed, not the harness.

After packing, delete the clone: it holds the answers.

    git clone --depth 1 https://github.com/Aider-AI/polyglot-benchmark SRC
    python3 prepare.py --src SRC --store ~/.bench-store/polyglot --languages python,go
    rm -rf SRC
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
from concurrent.futures import ThreadPoolExecutor

SKIP_DIRS = {'.meta', '.approaches', '.docs'}


def is_test_name(name: str) -> bool:
    base = pathlib.PurePosixPath(name).name
    return base.endswith(('_test.go', '_test.py')) or base.startswith('test_')


def test_command(lang: str, tests: list[str]) -> list[str]:
    if lang == 'python':
        return ['pytest', '-q', '-p', 'no:cacheprovider', *[t for t in tests if t.endswith('.py')]]
    if lang == 'go':
        return ['go', 'test', '-count=1', './...']
    raise SystemExit(f'unsupported language: {lang}')


def test_env() -> dict:
    return {**os.environ, 'GOPROXY': 'off', 'GOTOOLCHAIN': 'local', 'GOFLAGS': '-mod=mod'}


def instructions(ex: pathlib.Path) -> str:
    parts = []
    for name in ('introduction.md', 'instructions.md', 'instructions.append.md'):
        p = ex / '.docs' / name
        if p.exists():
            parts.append(p.read_text().strip())
    return '\n\n'.join(parts) + '\n'


def pack_one(src: pathlib.Path, store: pathlib.Path, lang: str, ex: pathlib.Path, check: bool) -> dict:
    cfg = json.loads((ex / '.meta' / 'config.json').read_text())['files']
    solution = cfg['solution']
    example = cfg.get('example', [])
    # Every file named like a test is hidden, whether or not the exercise's
    # config lists it: some Go exercises ship extra *_test.go files unlisted.
    named = {
        str(p.relative_to(ex))
        for p in ex.rglob('*')
        if p.is_file() and not SKIP_DIRS & set(p.relative_to(ex).parts) and is_test_name(str(p.relative_to(ex)))
    }
    tests = sorted(set(cfg.get('test', [])) | {e for e in cfg.get('editor', []) if is_test_name(e)} | named)
    hidden = set(tests) | set(example)

    out = store / f'{lang}-{ex.name}'
    if out.exists():
        shutil.rmtree(out)
    start = out / 'start'
    start.mkdir(parents=True)
    for p in sorted(ex.rglob('*')):
        rel = p.relative_to(ex)
        if p.is_dir() or SKIP_DIRS & set(rel.parts) or str(rel) in hidden:
            continue
        (start / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, start / rel)
    (start / 'INSTRUCTIONS.md').write_text(instructions(ex))

    with tarfile.open(out / 'tests.tar', 'w') as tar:
        for t in tests:
            tar.add(ex / t, arcname=t)

    ok = False
    if check and len(solution) == len(example):
        with tempfile.TemporaryDirectory() as tmp:
            work = pathlib.Path(tmp) / 'w'
            shutil.copytree(start, work)
            for s, e in zip(solution, example):
                shutil.copy2(ex / e, work / s)
            with tarfile.open(out / 'tests.tar') as tar:
                tar.extractall(work, filter='data')
            try:
                r = subprocess.run(test_command(lang, tests), cwd=work, env=test_env(), capture_output=True, text=True, timeout=240)
                ok = r.returncode == 0
            except subprocess.TimeoutExpired:
                ok = False

    spec = {'lang': lang, 'slug': ex.name, 'solution': solution, 'tests': tests, 'reference_ok': ok}
    (out / 'spec.json').write_text(json.dumps(spec, indent=1))
    return spec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, type=pathlib.Path, help='clone of Aider-AI/polyglot-benchmark')
    ap.add_argument('--store', required=True, type=pathlib.Path)
    ap.add_argument('--languages', default='python,go')
    ap.add_argument('--no-check', action='store_true', help="don't run the reference solutions")
    ap.add_argument('--jobs', type=int, default=6)
    args = ap.parse_args()

    args.store.mkdir(parents=True, exist_ok=True)
    jobs = []
    for lang in args.languages.split(','):
        base = args.src / lang / 'exercises' / 'practice'
        jobs += [(lang, ex) for ex in sorted(base.iterdir()) if (ex / '.meta' / 'config.json').exists()]

    with ThreadPoolExecutor(args.jobs) as pool:
        specs = list(pool.map(lambda j: pack_one(args.src, args.store, j[0], j[1], not args.no_check), jobs))

    for lang in args.languages.split(','):
        mine = [s for s in specs if s['lang'] == lang]
        good = [s for s in mine if s['reference_ok']]
        print(f'{lang}: {len(mine)} exercises, reference solution passes the hidden tests on {len(good)}')
        for s in mine:
            if not s['reference_ok']:
                print(f'  excluded: {s["slug"]}')
    (args.store / 'MANIFEST.json').write_text(json.dumps({'languages': args.languages.split(','), 'exercises': len(specs)}, indent=1))


if __name__ == '__main__':
    main()
