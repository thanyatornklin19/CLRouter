#!/bin/bash
# Runs one approach on a fresh copy of the task.
# usage: [EFFORT=low|medium|high|xhigh|max] bench/thai-tax/run.sh <name> <model> <plugin-dir or -> [prompt prefix, e.g. "/clrouter:dev "]
# Writes work-<name>/, out-<name>.json and time-<name>.txt under bench/thai-tax/runs/.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
RUNS=$HERE/runs; mkdir -p "$RUNS"
W=$RUNS/work-$1
rm -rf "$W" && mkdir -p "$W" && cd "$W" && git init -q
printf '{\n  "name": "thai-tax",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > package.json
git add -A && git -c user.email=bench@local -c user.name=bench commit -qm init
PLUGIN=(); [ "$3" != "-" ] && PLUGIN=(--plugin-dir "$3")
start=$(date +%s)
claude -p "${PLUGIN[@]}" ${EFFORT:+--effort "$EFFORT"} --model "$2" --dangerously-skip-permissions --output-format json \
  "${4:-}$(cat "$HERE/task.md")" < /dev/null > "$RUNS/out-$1.json" 2> "$RUNS/err-$1.txt"
echo "exit=$? seconds=$(( $(date +%s) - start ))" > "$RUNS/time-$1.txt"
