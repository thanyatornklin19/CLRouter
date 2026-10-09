# CLRouter

A Claude Code plugin that picks the right model for each prompt.

You type a prompt. CLRouter reads it, decides whether it needs **Haiku**, **Sonnet** or **Opus**, and, when that differs from the model you're on, asks you in Claude Code's own question dialog:

```
 CLRouter
 Haiku fits this prompt (quick factual question). Run it on Haiku instead of Opus?

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

## How it works

1. **`prompt.submit`**: the prompt is scored by keyword and structure signals (English and Thai): architecture, migrations, codebase-wide changes and hard debugging push up; quick questions, translations, typos and renames push down; pasted code never lands on Haiku. When the score is borderline, the `hybrid` judge asks the engine's small, fast model to classify it.
2. If the recommended tier is not the one you're on, it asks you (mode `ask`), switches silently (`auto`), or just tells you (`suggest`).
3. **`turn.step`**: every model request of that turn is sent to the chosen model. Subagents keep their own models.
4. If the chosen model never answers (wrong id, no access), the request is re-sent on your session model, so the router never costs you a turn.

CLRouter **abstains** when the prompt alone doesn't say enough: "yes", "continue", "ok do it", "ทำต่อ" and other short follow-ups keep the current model, because they continue whatever the conversation was doing.

## The cost trade-off

Per-prompt routing is not free. Your conversation is prompt-cached on the model you've been using. Another model has to read the whole context uncached. On a long conversation, sending a trivial question to Haiku can cost more than letting Opus answer it from cache.

So CLRouter never offers a downgrade once the context passes `downgradeMaxContext` (30k tokens by default), and the question tells you when a switch will re-read a large context. Upgrades are always offered: when a task needs a stronger model, quality beats the cache.

## `/clrouter:dev`: a pipeline with a model per role (experimental)

```
/clrouter:dev Add rate limiting to the /login endpoint, with tests
```

| Stage | Agent | Model | Why that model |
| --- | --- | --- | --- |
| Plan | `clrouter:planner` (read-only) | Opus | Decisions are where mistakes are expensive. |
| Build | `clrouter:coder` | Sonnet | Writing code to a clear plan doesn't need the top tier. |
| Review | `clrouter:reviewer` (read-only) | Opus | It reads the real `git diff`, not the coder's report. |
| Fix | `clrouter:coder` | Sonnet | Applies the numbered fixes. At most 2 review rounds. |
| Dispatch and summary | the command itself | Haiku | It only passes text between stages and sums up. |

Each stage starts in a fresh context, so the expensive model never re-reads your whole conversation.

**Measured, not assumed.** One small task (an `isPrime` function with tests, in a two-file repo), run once each:

| How | Cost | Result |
| --- | --- | --- |
| Sonnet alone | $0.07 | works, 5 tests |
| Opus alone | $0.14 | works, 8 tests |
| `/clrouter:dev` | $0.81 | works, 8 tests, review approved |

88% of the pipeline's cost was the two Opus stages, each exploring the code from scratch. Every stage has a fixed overhead: it reads the codebase, writes a plan or a review, and starts a new cache. On a small task that overhead is the whole bill. The pipeline pays off only when the task is big enough that Sonnet writing most of the code saves more than planning and review cost, or when a review catches a bug that would cost more to find later. For a small task, use one model.

To change a stage's model, edit `model:` in `agents/*.md` or `commands/dev.md`.

## Settings

Set them in `/config` (each field is a row) or in `settings.json` under `pluginConfigs.clrouter.options`.

| Option | Default | What it does |
| --- | --- | --- |
| `mode` | `ask` | `ask`: pop up before switching. `auto`: switch silently. `suggest`: toast the recommendation only. `off`: do nothing. |
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
- `agents/`, `commands/dev.md`: the `/clrouter:dev` pipeline's stages.
- `types/index.d.ts`: the session state the plugin keeps.
- `tests/`: `claude plugin test` suites.

Routing mistakes are the most useful bug reports: open an issue with the prompt, what CLRouter picked (`/clrouter test <prompt>`), and what it should have picked.

## ภาษาไทย

CLRouter คือปลั๊กอินของ Claude Code ที่เลือกโมเดลให้เหมาะกับแต่ละ prompt

พิมพ์ prompt ตามปกติ CLRouter จะวิเคราะห์ว่างานนี้ควรใช้ **Haiku** (คำถามสั้น แปลภาษา แก้คำผิด), **Sonnet** (งานเขียนโค้ดทั่วไป) หรือ **Opus** (ออกแบบสถาปัตยกรรม ย้ายระบบ debug ยาก แก้หลายไฟล์) ถ้าไม่ตรงกับโมเดลที่ใช้อยู่ จะเด้งหน้าต่างถามแบบเดียวกับที่ Claude ถามกลับ ให้เลือกว่าจะเปลี่ยนไหม เปลี่ยนแค่ prompt นั้น prompt ถัดไปกลับมาใช้โมเดลเดิม

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

**`/clrouter:dev <งาน>` (ทดลอง)**: แบ่งงาน dev ตามบทบาท Opus วางแผน, Sonnet เขียนโค้ด, Opus รีวิวจาก `git diff` จริง, Sonnet แก้ตามรีวิว (สูงสุด 2 รอบ), Haiku คุมขั้นตอนและสรุปผล

ผลที่วัดจริงกับงานเล็ก (เพิ่มฟังก์ชัน `isPrime` พร้อมเทสต์): ใช้ Sonnet ตัวเดียว $0.07, Opus ตัวเดียว $0.14, pipeline นี้ $0.81 ทุกขั้นมีต้นทุนคงที่ (อ่านโค้ดใหม่ เขียนแผน/รีวิว เริ่ม cache ใหม่) งานเล็กจึงแพงกว่าใช้โมเดลเดียว pipeline คุ้มเฉพาะงานใหญ่ที่ให้ Sonnet เขียนโค้ดส่วนใหญ่แล้วประหยัดได้มากกว่าค่าวางแผนกับค่ารีวิว

## License

MIT
