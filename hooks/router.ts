// The heuristic half of CLRouter: reads a prompt and says which tier of
// model fits it, or abstains. Pure functions, no engine calls, so the
// scoring can be tested and tuned on its own.

export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Confidence = 'high' | 'low'

/** The kind of work a prompt is: what picks both the model and the effort. */
export type Kind = 'answer' | 'build' | 'exact' | 'deep'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Route = {
  tier: Tier
  kind: Kind
  confidence: Confidence
  /** Labels of the signals that decided it, strongest first. */
  reasons: readonly string[]
  /** Weight of the deep-work signals: 3 or more is Opus work. */
  score: number
  /**
   * The cheapest tier this prompt may go to, whatever a classifier says:
   * code, building and exact rules never go below Sonnet.
   */
  floor: Tier
}

type Signal = { pattern: RegExp; weight: number; label: string }

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

const TIER_RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 }

export const tierRank = (tier: Tier): number => TIER_RANK[tier]

export const tierTitle = (tier: Tier): string =>
  tier.charAt(0).toUpperCase() + tier.slice(1)

// Which work fits which model, from the benchmarks in bench/:
//
// - Opus: deep work, where the hard part is deciding: architecture, a root
//   cause across systems, a security audit, a codebase-wide change.
// - Sonnet: building or changing code, and anything with exact rules. On a
//   well-specified build Sonnet matched or beat Opus at a third of the cost.
// - Haiku: answering, explaining, translating, summarizing and small
//   mechanical edits. It built a polished tax page with wrong legal caps,
//   so code and exact rules never go to it.
//
// English is matched on word boundaries; Thai has no spaces between words,
// so its phrases are matched as plain substrings.
const DEEP: readonly Signal[] = [
  {
    pattern:
      /\b(architect(ure|ural)?|system design|design (a|an|the) (new )?(system|service|platform|backend|schema))\b|สถาปัตยกรรม|ออกแบบระบบ/i,
    weight: 3,
    label: 'architecture / system design',
  },
  {
    pattern:
      /\b(across|throughout) (the )?(whole |entire )?(code ?base|repo(sitory)?|project|app)\b|\b(entire|whole) (code ?base|repo(sitory)?|project)\b|ทั้งโปรเจกต์|ทั้งโปรเจค|ทั้งระบบ/i,
    weight: 3,
    label: 'codebase-wide change',
  },
  {
    pattern:
      /\b(security (audit|review)|threat model(ing)?|vulnerabilit(y|ies)|exploit)\b|ช่องโหว่|ตรวจความปลอดภัย/i,
    weight: 3,
    label: 'security audit',
  },
  {
    pattern: /\b(migrat(e|ion|ing)|rewrite|re-?architect|from scratch|overhaul)\b|ย้ายระบบ|เขียนใหม่ทั้งหมด/i,
    weight: 2,
    label: 'migration / rewrite',
  },
  {
    pattern:
      /\b(race conditions?|deadlocks?|memory leaks?|concurrency|distributed|eventual consistency|scalab(ility|le)|multi-tenant|in production|across (the )?\w+ (and \w+ )?services)\b/i,
    weight: 2,
    label: 'hard systems problem',
  },
  {
    pattern:
      /\b(root cause|deep dive|investigate|figure out why|track down|trade-?offs?|pros and cons|compare (the )?(approaches|options|designs))\b|หาสาเหตุ|วิเคราะห์|เปรียบเทียบแนวทาง/i,
    weight: 2,
    label: 'root cause / trade-offs',
  },
  {
    pattern: /\b(roadmap|strategy|plan the)\b|วางแผน|กลยุทธ์/i,
    weight: 1,
    label: 'planning',
  },
]

// Making or changing software. Any of these keeps the prompt off Haiku.
const BUILD: readonly Signal[] = [
  {
    pattern:
      /\b(build|create|implement|develop|scaffold|set up)\b|\bmake (a|an|the|me)\b|\bwrite (a|an|the|me|some)? ?(function|script|program|class|component|test|tests|app|api|endpoint|query|module|cli|page|site)\b|สร้าง|พัฒนา|เขียนโค้ด|เขียนโปรแกรม|เขียนฟังก์ชัน|ทำเว็บ|ทำแอป|ทำหน้า|ทำระบบ/i,
    weight: 2,
    label: 'building software',
  },
  {
    pattern:
      /\b(add|fix|bugs?|debug|errors?|exceptions?|stack ?trace|refactor|tests?|endpoints?|components?|functions?|class|scripts?|api|quer(y|ies)|regex|features?|convert|parse|pr|pull request)\b|แก้บั๊ก|บั๊ก|เพิ่มฟีเจอร์|ฟังก์ชัน|ทดสอบ|แก้โค้ด|แก้ให้|ไม่ทำงาน/i,
    weight: 1,
    label: 'changing code',
  },
]

// Languages and tools. Naming one is code work only when the prompt isn't a
// question: "convert this CSV with Python" builds, "what is a closure in
// JavaScript?" asks.
const TECH: Signal = {
  pattern:
    /\b(python|javascript|typescript|node(\.?js)?|react|vue|sql|java|golang|rust|php|css|html|docker|kubernetes)\b/i,
  weight: 1,
  label: 'changing code',
}

// Rules that must come out exact. A cheap model answers these confidently
// and wrong, so they never go below Sonnet, built or asked.
const EXACT: Signal = {
  pattern:
    /\b(tax(es|ation)?|vat|payroll|withholding|interest rate|compound interest|loan|mortgage|amorti[sz]ation|invoice|accounting|ledger|insurance premium|pension|dosage|legal|compliance|regulation)\b|ภาษี|ค่าลดหย่อน|เงินเดือน|ดอกเบี้ย|เงินกู้|ผ่อน|บัญชี|ใบกำกับ|เบี้ยประกัน|กฎหมาย|ประกันสังคม|คำนวณ/i,
  weight: 0,
  label: 'exact rules (tax, money, law)',
}

const ANSWER: readonly Signal[] = [
  {
    pattern:
      /\b(what('s| is| are| does)|who (is|was)|define|definition of|meaning of|stands? for|explain|describe|difference between|why (is|does|do)|how (does|do|to))\b|คืออะไร|หมายถึง|แปลว่า|ย่อมาจาก|อธิบาย|ต่างกันยังไง|ต่างกันอย่างไร/i,
    weight: 2,
    label: 'question or explanation',
  },
  { pattern: /\btranslat(e|ion)\b|แปล(?!ง)/i, weight: 2, label: 'translation' },
  {
    pattern: /\b(typos?|spelling|grammar|rephrase|reword|proofread)\b|คำผิด|สะกด|เกลาภาษา/i,
    weight: 2,
    label: 'wording / typo fix',
  },
  {
    pattern: /\b(draft|e-?mail|caption|tweet|slogan|cover letter)\b|แคปชั่น|อีเมล|คำโปรย/i,
    weight: 2,
    label: 'short writing',
  },
  {
    pattern: /^(hi|hello|hey|yo|sup|thanks|thank you|thx)\b|^สวัสดี|^หวัดดี|^ขอบคุณ/i,
    weight: 2,
    label: 'small talk',
  },
  { pattern: /\b(summari[sz]e|summary|tl;?dr)\b|สรุป/i, weight: 2, label: 'summarization' },
  {
    pattern: /\b(rename|reformat|format|sort|indent)\b|เปลี่ยนชื่อ|จัดรูปแบบ/i,
    weight: 2,
    label: 'rename / formatting',
  },
  {
    pattern:
      /\b(syntax (for|of)|which command|what command|how do i|quick question|one[- ]liner|example of)\b|ใช้คำสั่งอะไร|ไวยากรณ์/i,
    weight: 1,
    label: 'syntax / how-to lookup',
  },
]

// Edits so small the word "fix" in them doesn't make them code work.
const MECHANICAL = /\b(typos?|spelling|rename|reformat|format|indent)\b|คำผิด|สะกด|เปลี่ยนชื่อ|จัดรูปแบบ/i

// A bare go-ahead continues whatever the conversation was doing: the prompt
// alone says nothing about the work, so the router keeps the current model.
const FOLLOW_UP =
  /^(y(es)?|yep|yeah|ok(ay)?|sure|go( ahead| on)?|continue|proceed|do it|lgtm|sounds good|next|ต่อ(เลย)?|ทำต่อ|ไปต่อ|ได้(เลย)?|โอเค|ตกลง|ใช่)[\s.!]*$/i

// Hosts wrap the typed prompt in blocks of their own (a reminder, the IDE's
// selection, a command's echo). Those are not the person's words: scored,
// a two-letter "yo" reads as a four-thousand-character brief.
const HARNESS_BLOCK =
  /<(system-reminder|local-command-[a-z]+|command-[a-z]+|ide_[a-z_]+|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/gi

/** The prompt as the person typed it, the host's own blocks taken out. */
export function typedText(text: string): string {
  return text.replace(HARNESS_BLOCK, '').trim()
}

const CODE_FENCE = /```/g
const FILE_PATH =
  /(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|cs|cpp|c|h|kt|swift|php|sql|ya?ml|json|toml|md|vue|svelte)\b/gi
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+\S/gm

const SHORT_CHARS = 60
const LONG_CHARS = 1500

const OPUS_AT_LEAST = 3

const matching = (signals: readonly Signal[], prompt: string): Signal[] =>
  signals.filter(signal => signal.pattern.test(prompt))

const total = (signals: readonly Signal[]): number =>
  signals.reduce((sum, signal) => sum + signal.weight, 0)

const byWeight = (signals: readonly Signal[]): string[] =>
  [...signals].sort((a, b) => b.weight - a.weight).map(signal => signal.label)

const CLASSIFY_MIN_CHARS = 20

/**
 * Whether a prompt the keywords abstained on is still worth handing to the
 * classifier: long enough to stand on its own, and no bare follow-up.
 */
export function isClassifiable(text: string): boolean {
  const prompt = typedText(text)
  return prompt.length >= CLASSIFY_MIN_CHARS && !prompt.startsWith('/') && !FOLLOW_UP.test(prompt)
}

/**
 * Names the tier whose kind of work this prompt is, or `null` when the
 * prompt carries too little signal to judge (a follow-up, a bare request
 * that only makes sense against the conversation).
 */
export function route(text: string): Route | null {
  const prompt = typedText(text)
  if (prompt === '' || prompt.startsWith('/') || FOLLOW_UP.test(prompt)) {
    return null
  }

  const deep = matching(DEEP, prompt)
  const build = matching(BUILD, prompt)
  const answer = matching(ANSWER, prompt)
  const isExact = EXACT.pattern.test(prompt)
  const hasCode = (prompt.match(CODE_FENCE) ?? []).length >= 2
  const files = new Set((prompt.match(FILE_PATH) ?? []).map(f => f.toLowerCase())).size
  const isSpec = (prompt.match(LIST_ITEM) ?? []).length >= 4
  const deepScore = total(deep)

  // Code work: a building verb, pasted code, files named, a spec, or a
  // coding word that isn't just part of a typo or rename.
  const isMechanical = MECHANICAL.test(prompt) && !build.some(s => s.weight >= 2)
  const codeSignals = isMechanical ? build.filter(s => s.weight >= 2) : [...build]
  if (answer.length === 0 && codeSignals.length === 0 && TECH.pattern.test(prompt)) {
    codeSignals.push(TECH)
  }
  const builds: string[] = byWeight(codeSignals)
  if (hasCode) builds.push('includes code')
  if (files >= 1) builds.push(files === 1 ? 'names a file' : `touches ${files} files`)
  if (isSpec) builds.push('detailed spec')
  const isCodeWork = builds.length > 0

  const floor: Tier = isCodeWork || isExact || deepScore >= 2 ? 'sonnet' : 'haiku'

  if (deepScore >= OPUS_AT_LEAST) {
    return {
      tier: 'opus',
      kind: 'deep',
      confidence: deepScore >= OPUS_AT_LEAST + 1 || deep.length >= 2 ? 'high' : 'low',
      reasons: byWeight(deep),
      score: deepScore,
      floor,
    }
  }

  if (floor === 'sonnet') {
    const reasons = [
      ...(isExact ? [EXACT.label] : []),
      ...builds,
      ...byWeight(deep),
    ]
    return {
      tier: 'sonnet',
      kind: isExact ? 'exact' : 'build',
      confidence: 'high',
      reasons,
      score: deepScore,
      floor,
    }
  }

  if (answer.length > 0) {
    return {
      tier: 'haiku',
      kind: 'answer',
      confidence: total(answer) >= 2 ? 'high' : 'low',
      reasons: byWeight(answer),
      score: deepScore,
      floor,
    }
  }

  // Nothing recognizable. Short: likely leans on the conversation, so keep
  // the current model. Long: a request worth a capable model.
  if (prompt.length < SHORT_CHARS) {
    return null
  }
  return {
    tier: 'sonnet',
    kind: 'build',
    confidence: 'low',
    reasons: [prompt.length >= LONG_CHARS ? 'long request' : 'general request'],
    score: deepScore,
    floor,
  }
}

/**
 * The effort a kind of work needs on the model that runs it, from the
 * benchmarks in bench/:
 *
 * - High and max bought nothing on builds. Sonnet at high cost 2× and Haiku
 *   at max 11× (25 minutes), for the same scores. So builds run at medium.
 *   Sonnet at low also passed (3 of 3) for 12% less, but on clear specs only.
 * - High fixed Haiku's careless errors: its tax caps went from 18-19/20 to
 *   20/20 twice. So Haiku, kept for code, runs at high.
 * - Effort didn't fix a misread rule: Opus missed the same cap at medium
 *   and high. Deep work runs at high on judgment; it isn't measured yet.
 * - Answers need little thought: low.
 *
 * Max is never chosen.
 */
export function effortFor(kind: Kind, tier: Tier | undefined): Effort {
  if (kind === 'answer') {
    return 'low'
  }
  if (kind === 'deep') {
    return 'high'
  }
  return tier === 'haiku' ? 'high' : 'medium'
}

/** The kind a tier's work is when only the tier is known (the classifier's). */
export function kindOfTier(tier: Tier, exact: boolean): Kind {
  return tier === 'haiku' ? 'answer' : tier === 'opus' ? 'deep' : exact ? 'exact' : 'build'
}

/**
 * The labels handed to the model classifier, one per tier. Hyphenated and
 * self-describing so the classifier can answer with a label alone.
 */
export const CLASSIFIER_LABELS: Record<Tier, string> = {
  haiku: 'answer-explain-translate-summarize-or-tiny-edit-no-new-code',
  sonnet: 'build-fix-or-speed-up-code-in-one-app-or-calculate-with-exact-rules',
  opus: 'system-architecture-security-audit-or-bug-spanning-several-services',
}

export function tierOfLabel(label: string | undefined): Tier | undefined {
  return TIERS.find(tier => CLASSIFIER_LABELS[tier] === label)
}

/**
 * Which tier a model id or alias belongs to, by the family name it carries
 * or by the ids the person configured; `undefined` when neither says.
 */
export function tierOfModel(
  model: string,
  configured: Readonly<Record<Tier, string>>,
): Tier | undefined {
  const id = model.toLowerCase()
  for (const tier of TIERS) {
    if (configured[tier].toLowerCase() === id) {
      return tier
    }
  }
  for (const tier of TIERS) {
    if (id.includes(tier)) {
      return tier
    }
  }
  return undefined
}

/** A short display name for a model id: its family, else the id itself. */
export function modelTitle(model: string): string {
  const family = /(haiku|sonnet|opus|fable)/i.exec(model)?.[1]
  return family === undefined
    ? model
    : family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()
}

/** Reads a tier out of free text typed under the dialog's "Other". */
export function tierInText(text: string): Tier | undefined {
  const lower = text.toLowerCase()
  return TIERS.find(tier => lower.includes(tier))
}
