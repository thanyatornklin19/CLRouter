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

## `/clrouter:dev`: a cost-tiered cascade (experimental, being benchmarked)

```
/clrouter:dev Add rate limiting to the /login endpoint, with tests
```

1. **Opus writes the acceptance tests** from the task, before any code exists. This is where the expensive model's judgment goes: deciding what "done" means, including domain rules the task only implies.
2. **The tests are locked.** They are archived and restored before every run, so the coder can't make them pass by editing them.
3. **The cheapest model that passes writes the code.** It tries `haiku`, `haiku` again, then `sonnet`, then `opus`, and stops at the first attempt whose tests pass.
4. **Haiku runs the steps and writes the summary.**

**Why it changed.** The previous version planned on Opus, coded on Sonnet and reviewed on Opus. Measured, it cost more than a single model for the same result:

- On a small task: $0.81, against $0.14 for Opus alone.
- On a well-specified hard task: $1.09, against $0.05 for Haiku alone. All four approaches passed the 48 hidden tests.
- Its coder-written tests missed 2 of 3 bugs planted to check them.

The cascade is being benchmarked against single models now. This section will carry the numbers, whichever way they go.

To change a stage's model, edit `model:` in `agents/*.md`, or the attempt order in `commands/dev.md`.

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
- `agents/`, `commands/dev.md`: the `/clrouter:dev` cascade's stages.
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

**`/clrouter:dev <งาน>` (ทดลอง, กำลังวัดผล)**: Opus เขียน acceptance tests จากโจทย์ก่อนมีโค้ด แล้วล็อกไว้ (คืนค่าเดิมทุกครั้งก่อนรัน แก้เทสต์ให้ผ่านไม่ได้) จากนั้นให้โมเดลถูกที่สุดเขียนโค้ด ลอง Haiku → Haiku → Sonnet → Opus หยุดที่ตัวแรกที่ผ่าน

แบบเดิม (Opus วางแผน/รีวิว) วัดแล้วแพงกว่าใช้โมเดลเดียวโดยได้ผลเท่ากัน จึงเปลี่ยนเป็นแบบนี้ ผลวัดของแบบใหม่จะใส่ไว้ที่นี่ ไม่ว่าจะออกมาดีหรือแย่

## License

MIT
