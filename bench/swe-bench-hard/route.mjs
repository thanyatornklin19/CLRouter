// Prints the router's verdict for each task's issue text, with no model call.
// Reads {id: text} as JSON on stdin; writes {id: {tier, kind, confidence, effort}}.
//
//   node --experimental-strip-types route.mjs < issues.json
//
// This is the keyword router alone (judge "heuristic"). The plugin switches
// only on a high-confidence verdict and otherwise keeps the session model; the
// default "hybrid" judge would ask a classifier model on the low-confidence
// ones, which can't be replayed offline.
import { route, effortFor } from '../../hooks/router.ts'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
const out = {}
for (const [id, text] of Object.entries(JSON.parse(raw))) {
  const r = route(text)
  out[id] = r === null ? null : { tier: r.tier, kind: r.kind, confidence: r.confidence, effort: effortFor(r.kind, r.tier) }
}
process.stdout.write(JSON.stringify(out))
