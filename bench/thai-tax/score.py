#!/usr/bin/env python3
"""Scores every finished run: cost, time, hidden tests, browser check."""
import glob, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "runs")
rows = []
for out in sorted(glob.glob(f"{T}/out-*.json")):
    name = os.path.basename(out)[4:-5]
    work = f"{T}/work-{name}"
    row = {"name": name}
    try:
        d = json.load(open(out))
        row["cost"] = round(d.get("total_cost_usd", 0), 3)
        row["error"] = d.get("is_error")
        row["models"] = {k.replace("claude-", ""): round(v.get("costUSD", 0), 3) for k, v in (d.get("modelUsage") or {}).items()}
        row["result"] = (d.get("result") or "")[:600]
    except Exception as e:
        row["cost"] = None
        row["error"] = f"no result: {e}"
    t = open(f"{T}/time-{name}.txt").read() if os.path.exists(f"{T}/time-{name}.txt") else ""
    m = re.search(r"seconds=(\d+)", t)
    row["seconds"] = int(m.group(1)) if m else None
    module = f"{work}/src/tax.js"
    if os.path.exists(module):
        p = subprocess.run(["node", "--test", f"{HERE}/hidden-tests.mjs"], env={**os.environ, "TAX_MODULE": module},
                           capture_output=True, text=True, timeout=120)
        passed = re.search(r"^# pass (\d+)", p.stdout, re.M)
        failed = re.findall(r"^not ok \d+ - (.*)$", p.stdout, re.M)
        row["hidden"] = f"{passed.group(1) if passed else 0}/20"
        row["hidden_failed"] = failed
    else:
        row["hidden"] = "0/20 (no src/tax.js)"
    shot = f"{T}/shot-{name}.png"
    try:
        p = subprocess.run(["node", f"{HERE}/ui-check.mjs", work, shot], capture_output=True, text=True, timeout=90)
        ui = json.loads(p.stdout.strip().splitlines()[-1])
        row["ui"] = f"{sum(c['ok'] for c in ui)}/{len(ui)}"
        row["ui_detail"] = ui
    except Exception as e:
        row["ui"] = f"check failed: {e}"
    rows.append(row)

json.dump(rows, open(f"{T}/scores.json", "w"), ensure_ascii=False, indent=1)
for r in rows:
    print(f"{r['name']:<12} cost=${r.get('cost')}  {r.get('seconds')}s  hidden={r.get('hidden')}  ui={r.get('ui')}  models={r.get('models')}")
    for f in r.get("hidden_failed", []):
        print(f"{'':14}hidden fail: {f}")
    for c in r.get("ui_detail", []) if isinstance(r.get("ui_detail"), list) else []:
        if not c["ok"]:
            print(f"{'':14}ui fail [{c['case']}]: {c['detail'][:160]} {c['errors'][:1]}")
