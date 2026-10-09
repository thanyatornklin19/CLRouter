// The heuristic half of CLRouter: reads a prompt and says which tier of
// model fits it, or abstains. Pure functions, no engine calls, so the
// scoring can be tested and tuned on its own.

export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Confidence = 'high' | 'low'

export type Route = {
  tier: Tier
  confidence: Confidence
  /** Labels of the signals that decided it, strongest first. */
  reasons: readonly string[]
  /** Net score: negative leans cheap, positive leans capable. */
  score: number
}

type Signal = { pattern: RegExp; weight: number; label: string }

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

const TIER_RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 }

export const tierRank = (tier: Tier): number => TIER_RANK[tier]

export const tierTitle = (tier: Tier): string =>
  tier.charAt(0).toUpperCase() + tier.slice(1)

// English is matched on word boundaries; Thai has no spaces between words,
// so its phrases are matched as plain substrings.
const COMPLEX: readonly Signal[] = [
  {
    pattern:
      /\b(architect(ure|ural)?|system design|design (a|an|the) (new )?(system|service|platform|backend|schema))\b|สถาปัตยกรรม|ออกแบบระบบ/i,
    weight: 3,
    label: 'architecture / system design',
  },
  {
    pattern:
      /\b(migrat(e|ion|ing)|rewrite|re-?architect|from scratch|overhaul)\b|ย้ายระบบ|เขียนใหม่ทั้งหมด/i,
    weight: 2,
    label: 'migration / rewrite',
  },
  {
    pattern:
      /\b(across|throughout) (the )?(whole |entire )?(code ?base|repo(sitory)?|project|app)\b|\b(entire|whole) (code ?base|repo(sitory)?|project)\b|\bmulti(ple)?[- ]files?\b|ทั้งโปรเจกต์|ทั้งโปรเจค|ทั้งระบบ|หลายไฟล์/i,
    weight: 2,
    label: 'codebase-wide change',
  },
  {
    pattern:
      /\b(race conditions?|deadlocks?|memory leaks?|concurren(cy|t)|distributed|eventual consistency|scalab(ility|le)|multi-tenant)\b/i,
    weight: 2,
    label: 'hard systems problem',
  },
  {
    pattern:
      /\b(security (audit|review)|threat model(ing)?|vulnerabilit(y|ies)|exploit)\b|ช่องโหว่|ความปลอดภัย/i,
    weight: 2,
    label: 'security analysis',
  },
  {
    pattern:
      /\b(root cause|deep dive|investigate|trade-?offs?|pros and cons|compare (the )?(approaches|options|designs))\b|หาสาเหตุ|วิเคราะห์|เปรียบเทียบ/i,
    weight: 2,
    label: 'deep analysis',
  },
  {
    pattern: /\b(plan|roadmap|strategy)\b|วางแผน|กลยุทธ์/i,
    weight: 1,
    label: 'planning',
  },
  {
    pattern:
      /\b(optimi[sz]e|optimi[sz]ation|performance|latency|throughput|algorithm|time complexity|prove|proof)\b|ประสิทธิภาพ|อัลกอริทึม/i,
    weight: 1,
    label: 'optimization / algorithms',
  },
  { pattern: /\bdesign\b|ออกแบบ/i, weight: 1, label: 'design work' },
]

const SIMPLE: readonly Signal[] = [
  {
    pattern:
      /\b(what('s| is| are| does)|who (is|was)|define|definition of|meaning of|stands? for)\b|คืออะไร|หมายถึง|แปลว่า|ย่อมาจาก/i,
    weight: 2,
    label: 'quick factual question',
  },
  {
    pattern: /\btranslat(e|ion)\b|แปล/i,
    weight: 2,
    label: 'translation',
  },
  {
    pattern:
      /\b(typos?|spelling|grammar|rephrase|reword|proofread)\b|คำผิด|สะกด|เกลาภาษา/i,
    weight: 2,
    label: 'wording / typo fix',
  },
  {
    pattern: /^(hi|hello|hey|yo|sup|thanks|thank you|thx)\b|^สวัสดี|^หวัดดี|^ขอบคุณ/i,
    weight: 2,
    label: 'small talk',
  },
  {
    pattern: /\b(summari[sz]e|summary|tl;?dr)\b|สรุป/i,
    weight: 1,
    label: 'summarization',
  },
  {
    pattern: /\b(rename|reformat|format|sort|indent)\b|เปลี่ยนชื่อ|จัดรูปแบบ/i,
    weight: 1,
    label: 'mechanical edit',
  },
  {
    pattern:
      /\b(syntax (for|of)|which command|what command|how do i|quick question|one[- ]liner|example of)\b|ใช้คำสั่งอะไร|ไวยากรณ์/i,
    weight: 1,
    label: 'syntax / how-to lookup',
  },
]

// Ordinary coding work. It counts once however many words match: it keeps
// a routine task off the cheapest tier without pushing it to the top one.
const STANDARD =
  /\b(implement|add|fix|bug|debug|error|exception|stack ?trace|refactor|tests?|unit tests?|endpoint|component|function|class|script|api|query|regex)\b|เขียนโค้ด|แก้บั๊ก|เพิ่มฟีเจอร์|ฟังก์ชัน|ทดสอบ/i

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
const VERY_LONG_CHARS = 4000

const HAIKU_AT_MOST = -2
const OPUS_AT_LEAST = 3

/**
 * Scores a prompt and names the tier that fits it, or `null` when the
 * prompt carries too little signal to judge (a follow-up, a bare request
 * that only makes sense against the conversation).
 */
export function route(text: string): Route | null {
  const prompt = typedText(text)
  if (prompt === '' || prompt.startsWith('/') || FOLLOW_UP.test(prompt)) {
    return null
  }

  const hits: Signal[] = []
  let complex = 0
  let simple = 0

  for (const signal of COMPLEX) {
    if (signal.pattern.test(prompt)) {
      complex += signal.weight
      hits.push(signal)
    }
  }
  for (const signal of SIMPLE) {
    if (signal.pattern.test(prompt)) {
      simple += signal.weight
      hits.push({ ...signal, weight: -signal.weight })
    }
  }

  const isStandard = STANDARD.test(prompt)
  const hasKeywords = hits.length > 0 || isStandard

  const files = new Set((prompt.match(FILE_PATH) ?? []).map(f => f.toLowerCase()))
  if (files.size >= 3) {
    complex += 2
    hits.push({ pattern: FILE_PATH, weight: 2, label: `touches ${files.size} files` })
  }

  const listItems = (prompt.match(LIST_ITEM) ?? []).length
  if (listItems >= 4) {
    complex += 1
    hits.push({ pattern: LIST_ITEM, weight: 1, label: 'multi-step requirements' })
  }

  if (prompt.length >= VERY_LONG_CHARS) {
    complex += 2
    hits.push({ pattern: /$/, weight: 2, label: 'very long, detailed prompt' })
  } else if (prompt.length >= LONG_CHARS) {
    complex += 1
    hits.push({ pattern: /$/, weight: 1, label: 'long, detailed prompt' })
  } else if (prompt.length < SHORT_CHARS) {
    if (!hasKeywords) {
      return null
    }
    simple += 1
  }

  const score = complex - simple + (isStandard ? 1 : 0)
  const hasCode = (prompt.match(CODE_FENCE) ?? []).length >= 2

  let tier: Tier =
    score <= HAIKU_AT_MOST ? 'haiku' : score >= OPUS_AT_LEAST ? 'opus' : 'sonnet'
  let confidence: Confidence
  if (tier === 'haiku') {
    confidence = score <= HAIKU_AT_MOST - 1 ? 'high' : 'low'
  } else if (tier === 'opus') {
    confidence = score >= OPUS_AT_LEAST + 1 ? 'high' : 'low'
  } else {
    confidence = isStandard && complex === 0 && simple <= 1 ? 'high' : 'low'
  }

  // Pasted code is code work: never the cheapest tier on keywords alone.
  if (tier === 'haiku' && hasCode) {
    tier = 'sonnet'
    confidence = 'low'
    hits.push({ pattern: CODE_FENCE, weight: 0, label: 'includes code' })
  }

  const reasons = hits
    .filter(hit => (tier === 'haiku' ? hit.weight < 0 : hit.weight >= 0))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .map(hit => hit.label)
  if (reasons.length === 0) {
    reasons.push(tier === 'sonnet' ? 'routine coding task' : 'general request')
  }

  return { tier, confidence, reasons, score }
}

/**
 * The labels handed to the model classifier, one per tier. Hyphenated and
 * self-describing so the classifier can answer with a label alone.
 */
export const CLASSIFIER_LABELS: Record<Tier, string> = {
  haiku: 'simple-question-lookup-translation-or-tiny-edit',
  sonnet: 'routine-coding-or-writing-task',
  opus: 'complex-architecture-deep-debugging-or-large-multi-file-work',
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
