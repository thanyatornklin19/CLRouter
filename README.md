# CLRouter

A Claude Code plugin that picks the right model for each prompt.

You type a prompt. CLRouter reads it, decides whether it needs **Haiku**, **Sonnet** or **Opus**, and, when that differs from the model you're on, asks you in Claude Code's own question dialog:

```
 CLRouter
 Haiku fits this prompt (question or explanation). Run it on Haiku instead of Opus?

 ❯ 1. Use Haiku for this prompt
   2. Keep Opus
   3. Auto-route this session
   4. Turn off this session
   5. Other
```

Pick one and the turn runs on that model. Your session model is unchanged: the next prompt starts from it again.

[ภาษาไทยอยู่ด้านล่าง](#ภาษาไทย)

## Install

In a Claude Code terminal session:

```
/plugin install clrouter --marketplace thanyatornklin19/CLRouter
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

Requires a Claude Code build with the function-hooks plugin API (built and tested on 2.1.295). That API is early access and can change between releases.

## Which work goes to which model

The rules come from the benchmarks in [`bench/`](bench/), not from a hunch:

| Model | Work it gets | Why |
| --- | --- | --- |
| **Haiku** | Answering and explaining, translating, summarizing, short writing (an email, a caption), typos, renames, formatting | Cheap and good at these. It never gets code to build, because it built a polished tax page with wrong legal caps, twice. |
| **Sonnet** | Building or changing code, and anything with **exact rules**: tax, VAT, payroll, interest, loans, insurance, law, in Thai or English | On the tax app it was right 2 of 2 at $0.16. Opus was right 1 of 2 at $0.51. |
| **Opus** | Architecture and system design, security audits, codebase-wide changes, migrations, bugs that span several services | Where the hard part is deciding, not typing. This tier is a judgment: no benchmark has measured it yet. |

Exact rules have a **floor**. A prompt about tax or money never goes below Sonnet, whether it asks for code or just a number ("what is the VAT on 12,500 baht?").

## How it works

1. **`prompt.submit`**: keywords in English and Thai put the prompt in one of the three kinds of work above.
2. **The classifier.** When the keywords are unsure, or find nothing in a prompt long enough to stand on its own, the `hybrid` judge asks the engine's small model. That model can move a prompt up but never below its floor. It can only send a prompt to Haiku when the keywords also read it as a question.
3. **Asking you.** If the recommended model isn't the one you're on, CLRouter asks you (mode `ask`), switches silently (`auto`), or just tells you (`suggest`).
4. **`turn.step`**: every model request of that turn goes to the chosen model. Subagents keep their own models.
5. **Fallback.** If the chosen model never answers (a wrong id, no access), the request is re-sent on your session model, so the router never costs you a turn.

CLRouter **abstains** when a prompt alone doesn't say enough. "yes", "continue", "ok do it", "ทำต่อ" and other short follow-ups keep the current model, because they continue whatever the conversation was doing.

**How accurate the keywords are.** On 20 prompts written after tuning and never tuned against, they picked the right model 14 times and left 2 to the current model:

- 3 Opus-kind prompts went to Sonnet, which is cheaper and probably still fine.
- 1 Haiku-kind prompt went to Sonnet, which is costlier but safe.
- None was sent to Haiku when it needed more.

The classifier then fixes some of the misses; `/clrouter test <prompt>` shows its call.

## Effort, per prompt

With `effort: auto` (the default), each prompt also runs at the effort its work needs on the model that runs it:

| Work | Effort |
| --- | --- |
| Answering, explaining, translating, small edits | `low` |
| Building or changing code, and exact rules, on Sonnet or Opus | `medium` |
| The same, when Haiku runs it (you kept Haiku) | `high` |
| Architecture, security audits, codebase-wide changes | `high` |

CLRouter never picks `max`.

The [tax benchmark](bench/thai-tax#effort) is where these come from:

- **High and max bought nothing on builds.** Sonnet at high cost 2× for the same score. Haiku at max cost 11× and took 25 minutes, for the same score.
- **High fixed Haiku's careless errors.** Its scores went from 18 and 19 out of 20 to 20/20 twice.
- **Effort didn't fix a misread rule.** Opus missed the same cap at medium and at high.
- **Low passed too (3 of 3 runs, 12% cheaper).** Builds still run at medium, because those runs were all on clear specs.
- **Deep work's `high` is a judgment.** It isn't measured yet.

**How effort is applied:**

- **The model changes.** The popup names the effort, for example "Run it on Sonnet at medium effort instead of Opus?".
- **The model already fits.** Only the effort changes, without asking, and the status line shows it.
- **Follow-ups keep your effort.** "yes", "ทำต่อ" and the like stay at what you set.
- **To turn this off,** set `effort: off`.

**Known gap.** A question about a deep topic ("what's the trade-off between a monolith and microservices?") is treated like doing deep work: Opus at high.

## The cost trade-off

Per-prompt routing is not free. Your conversation is prompt-cached on the model you've been using. Another model has to read the whole context uncached. On a long conversation, sending a trivial question to Haiku can cost more than letting Opus answer it from cache.

So CLRouter never offers a downgrade once the context passes `downgradeMaxContext` (30k tokens by default), and the question tells you when a switch will re-read a large context. Upgrades are always offered: when a task needs a stronger model, quality beats the cache.

## `/clrouter:dev`: a cascade with locked tests (experimental)

```
/clrouter:dev Add rate limiting to the /login endpoint, with tests
```

1. **Sonnet writes the acceptance tests** from the task, before any code exists. They encode what the task requires, including domain rules it only implies.
2. **The tests are locked.** They are archived and restored before every run, so the coder can't pass by editing them.
3. **The cheapest model that passes writes the code.** It tries `haiku`, `haiku` again, then `sonnet`, then `opus`, and stops at the first attempt whose tests pass.
4. **Haiku runs the steps and writes the summary.**

### What it's good for, measured

The benchmark in [`bench/thai-tax`](bench/thai-tax) builds a Thai income tax web app. Each approach is scored by 20 hidden tests and a real browser:

| Approach | Avg cost | Hidden tests |
| --- | --- | --- |
| Sonnet alone | $0.16 | 20/20, 20/20 |
| Haiku alone | $0.07 | 18/20, 19/20 |
| Opus alone | $0.51 | 20/20, 19/20 |
| Cascade, Sonnet tests | $0.26 | 20/20 |
| Cascade, Opus tests | $0.76 | 20/20, 20/20 |

- **The cascade buys correctness, not savings.** In every cascade run, Haiku wrote the code that passed, and it scored 20/20. Alone, Haiku shipped polished pages with wrong tax caps. The locked tests carried the rules it didn't know.
- **On a task this size, the cascade cost more than Sonnet alone.** Writing the tests costs about as much as writing the code. It can only save money when the code is much bigger than its tests, and that isn't measured yet.
- **That's why Sonnet writes the tests.** Opus tests cost 3× as much for the same score.

**Known issue.** When a stage runs long, Claude Code can finish it in a new turn. That turn runs on your session's model instead of Haiku. It cost $0.14 extra on a Sonnet session, and it would cost more on Opus.

To change a stage's model, edit `model:` in `agents/*.md`, or the attempt order in `commands/dev.md`.

## Settings

Set them in `/config` (each field is a row) or in `settings.json` under `pluginConfigs.clrouter.options`.

| Option | Default | What it does |
| --- | --- | --- |
| `mode` | `ask` | `ask`: pop up before switching. `auto`: switch silently. `suggest`: toast the recommendation only. `off`: do nothing. |
| `effort` | `auto` | `auto`: set each prompt's effort to fit its work, as above. `off`: leave effort as you set it. |
| `judge` | `hybrid` | `heuristic`: keywords only, free and instant. `hybrid`: ask the small model when the keywords are unsure. `model`: always ask it. |
| `haikuModel` | `haiku` | Model for simple prompts. Alias or full id. |
| `sonnetModel` | `sonnet` | Model for routine prompts. |
| `opusModel` | `opus` | Model for complex prompts. |
| `downgradeMaxContext` | `30000` | No downgrade past this many context tokens. |

Aliases are resolved to full ids by the plugin: `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` win when set (Bedrock, Vertex, gateways), otherwise `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`. On any other provider or for newer models, put full ids in the three model options.

## Command

| Command | |
| --- | --- |
| `/clrouter` | Mode, models, and the last routing decision. |
| `/clrouter ask \| auto \| suggest \| off` | Set the mode for this session. |
| `/clrouter reset` | Back to the configured mode. |
| `/clrouter test <prompt>` | Show which tier a prompt gets and why, without sending it. |

## Develop

```
git clone https://github.com/thanyatornklin19/CLRouter
cd CLRouter
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`claude --plugin-dir .` loads the working copy and reloads it on save. The first load writes the API's types to `.claude-plugin/types/` (git-ignored), after which `tsc -p .` type-checks the plugin.

Layout:

- `hooks/router.ts`: the heuristic scorer. Pure functions; tune the signals here.
- `hooks/register.ts`: the hooks (prompt, turn, command) and the dialog.
- `agents/`, `commands/dev.md`: the `/clrouter:dev` cascade's stages.
- `bench/`: benchmarks with hidden tests, for checking claims before they go in this README.
- `types/index.d.ts`: the session state the plugin keeps.
- `tests/`: `claude plugin test` suites.

Routing mistakes are the most useful bug reports: open an issue with the prompt, what CLRouter picked (`/clrouter test <prompt>`), and what it should have picked.

## ภาษาไทย

CLRouter คือปลั๊กอินของ Claude Code ที่เลือกโมเดลให้เหมาะกับแต่ละ prompt

พิมพ์ prompt ตามปกติ CLRouter จะดูว่างานนี้เป็นงานแบบไหน แล้วเลือกโมเดลที่เหมาะกับงานนั้น (กฎมาจากผลวัดจริงใน `bench/`):

- **Haiku**: ตอบคำถาม อธิบาย แปล สรุป เขียนข้อความสั้น (อีเมล แคปชั่น) แก้คำผิด เปลี่ยนชื่อ จัดรูปแบบ **ไม่ให้เขียนโค้ดสร้างของ**
- **Sonnet**: สร้างหรือแก้โค้ด และ**งานที่มีกฎตายตัว** (ภาษี VAT เงินเดือน ดอกเบี้ย เงินกู้ ประกัน กฎหมาย) งานกลุ่มนี้ไม่มีวันถูกส่งไปต่ำกว่า Sonnet แม้จะแค่ถามตัวเลข เพราะ Haiku ตอบผิดได้แบบดูน่าเชื่อ
- **Opus**: ออกแบบสถาปัตยกรรม ตรวจช่องโหว่ แก้ทั้ง codebase ย้ายระบบ บั๊กที่ข้ามหลาย service

ถ้าไม่ตรงกับโมเดลที่ใช้อยู่ จะเด้งหน้าต่างถามแบบเดียวกับที่ Claude ถามกลับ เปลี่ยนแค่ prompt นั้น prompt ถัดไปกลับมาใช้โมเดลเดิม

**Effort ปรับให้เองทุก prompt** (ค่าเริ่มต้น `effort: auto`):

- งานตอบคำถาม: `low`
- งานโค้ดและงานที่มีกฎตายตัว: `medium` (ถ้าให้ Haiku ทำ ใช้ `high`)
- งานออกแบบหรือตรวจช่องโหว่: `high`
- ไม่เลือก `max` เด็ดขาด

ผลวัด: Sonnet ที่ high แพงขึ้น 2 เท่า Haiku ที่ max แพงขึ้น 11 เท่าและใช้เวลา 25 นาที ทั้งคู่ได้ผลเท่าเดิม ส่วน Haiku ที่ high แก้ความสะเพร่าได้ (คำนวณภาษีถูก 20/20 ทั้งสองรอบ) effort ช่วยแก้ความสะเพร่า แต่แก้ความไม่รู้ไม่ได้

**ติดตั้ง** (พิมพ์ใน Claude Code):

```
/plugin install clrouter --marketplace thanyatornklin19/CLRouter
```

**สิ่งที่ควรรู้**

- โหมด: `ask` ถามก่อนเปลี่ยน (ค่าเริ่มต้น), `auto` เปลี่ยนเลยไม่ถาม, `suggest` แค่แนะนำ, `off` ปิด เปลี่ยนได้ด้วย `/clrouter auto` เป็นต้น
- prompt สั้นๆ ที่ต่อจากงานเดิม เช่น "ทำต่อ", "โอเค", "yes" จะไม่ถูกเปลี่ยนโมเดล เพราะดูจากข้อความอย่างเดียวไม่รู้ว่างานยากแค่ไหน
- การเปลี่ยนโมเดลกลางบทสนทนามีต้นทุน: โมเดลใหม่ต้องอ่าน context ทั้งหมดโดยไม่มี cache ถ้าบทสนทนายาวเกิน 30k tokens จะไม่เสนอให้ลดเป็นโมเดลถูกกว่า เพราะจะแพงกว่าเดิม
- ถ้าโมเดลที่เลือกตอบไม่ได้ (id ผิด ไม่มีสิทธิ์ใช้) จะส่งใหม่ด้วยโมเดลของ session อัตโนมัติ
- ลองดูว่า prompt ไหนจะได้โมเดลอะไร: `/clrouter test <ข้อความ>`

**`/clrouter:dev <งาน>` (ทดลอง)**: Sonnet เขียน acceptance tests จากโจทย์ก่อนมีโค้ด แล้วล็อกไว้ (คืนค่าเดิมก่อนรันทุกครั้ง แก้เทสต์ให้ผ่านไม่ได้) จากนั้นให้โมเดลถูกที่สุดเขียนโค้ด ลอง Haiku → Haiku → Sonnet → Opus หยุดที่ตัวแรกที่ผ่าน

ผลวัดจากโจทย์สร้างเว็บคำนวณภาษีไทย ([`bench/thai-tax`](bench/thai-tax)):

- **Sonnet ตัวเดียวคุ้มที่สุด**: $0.16 ถูก 20/20 ทั้ง 2 รอบ
- **Haiku ตัวเดียวถูกที่สุด ($0.07) แต่คำนวณภาษีผิดแบบเงียบๆ**: หน้าเว็บสวย แต่ใช้เพดานลดหย่อนผิด รอบละข้อ
- **Opus ตัวเดียวไม่ได้ปลอดภัยกว่า**: รอบสองพลาดเพดาน PVD 15%
- **cascade ช่วยเรื่องความถูกต้อง ไม่ได้ช่วยประหยัด**: Haiku เขียนโค้ดผ่านเทสต์ที่ล็อกไว้ได้ 20/20 ทุกรอบ แต่รวมแล้วแพงกว่า Sonnet ตัวเดียว ($0.26) เพราะงานขนาดนี้ค่าเขียนเทสต์พอๆ กับค่าเขียนโค้ด

## License

MIT
