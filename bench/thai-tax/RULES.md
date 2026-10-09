# The tax rules behind the hidden tests

**Status: author-written, checked against Revenue Department pages through a search tool. Not yet checked against the tax-year 2567 form instructions themselves.**

The 20 hidden tests in [`hidden-tests.mjs`](hidden-tests.mjs) and the reference in [`reference/src/tax.js`](reference/src/tax.js) encode Thai personal income tax for tax year 2567, salary income only. They were written by the same author who wrote the router, from memory, and one expected value was wrong the first time (a hand-computed total, found when the reference failed its own test).

So each rule was looked up. The lookups were run through a search tool, which returns a summary of `rd.go.th` pages. The sandbox cannot open `rd.go.th` directly (the network policy denies the host), so **nobody has read the primary documents for this benchmark yet.**

## Rule by rule

"Seen" means a search summary of a Revenue Department page stated it, with the quoted text shown. It is not a check of the tax-year 2567 form.

| Rule used | Value | Seen on `rd.go.th`? | Tests |
| --- | --- | --- | --- |
| Expense deduction, salary | 50% of income, at most 100,000 (s.42 bis) | Yes: "ร้อยละ 50 ของเงินได้แต่ไม่เกิน 100,000 บาท", in effect from 1 Jan 2560 | `expense is 50%…`, `bracket boundaries` |
| Personal allowance | 60,000 | Yes | `personal allowance` |
| Spouse with no income | 60,000 | Yes | `spouse and parents` |
| Child | 30,000 each | Yes | `children…` |
| Second and later child born in or after 2561 | 60,000 each (30,000 extra) | Yes: "ตั้งแต่คนที่สองเป็นต้นไปได้เพิ่มอีกคนละ 30,000 บาท"; order counts every child, living or not | `children…` |
| Parents | 30,000 each, up to 4 (own and spouse's) | Yes | `spouse and parents` |
| Social security | as paid, at most 9,000 | Yes (s.33 insured) | `social security capped…` |
| Life insurance + own health insurance | health at most 25,000, together at most 100,000 | Yes | `life insurance…`, `health insurance…` |
| Parents' health insurance | at most 15,000, separate from the 100,000 | Yes | `parents' health insurance…` |
| Provident fund | at most 15% of wages and at most 500,000 | Yes | `provident fund capped…` |
| RMF | at most 30% of income and at most 500,000 (15% before 2563) | Yes: the change came with the 2563 rules | `RMF capped…` |
| SSF | at most 30% and at most 200,000, for units bought 2563–2567 | Yes: the window ends in 2567, the year tested | `SSF capped…` |
| Provident fund + RMF + SSF together | at most 500,000 | Yes | `PVD + RMF + SSF together…` |
| Home loan interest | as paid, at most 100,000 | Yes | `home loan interest…` |
| Donations | at most 10% of income after expenses and the other allowances | Yes | `donation capped…` |
| Tax rates on net income | 0 to 150,000 exempt, then 5, 10, 15, 20, 25, 30, 35% at 300k, 500k, 750k, 1M, 2M, 5M | Yes | `bracket boundaries` |

## Not modelled, on purpose

The task gives these as inputs and assumes they are met. A real return checks them.

- **Eligibility:** parents aged 60 or over with income of at most 30,000; children who are minors or students under 25 with income below 30,000; a lawful spouse; adopted children not counting as the second child.
- **Documents and policy conditions:** life insurance policies of at least 10 years; a home loan secured by a mortgage; receipts.
- **Other income types, donations worth double, pension insurance, and the other allowances** on the form.

## What was not confirmed

- **The tax-year 2567 form instructions were not opened.** They exist: [ภ.ง.ด.91 instructions, tax year 2567](https://www.rd.go.th/fileadmin/tax_pdf/pit/2567/Ins91_101067.pdf) and [ภ.ง.ด.90](https://www.rd.go.th/fileadmin/tax_pdf/pit/2567/Ins90_101067.pdf). By the search summaries' own account, the pages behind the table are dated 2560 to 2566. The rules above are stable across those years, apart from the RMF and SSF changes noted, but "stable" is an inference.
- **The Revenue Department's online calculator was not used.** The plan was to enter ten returns and compare totals with the reference. Not done.
- **One summary hedged on the RMF rate:** "ร้อยละ 15 กับร้อยละ 30 ... ควรยืนยันอัตราตามปีภาษี". The 30% above rests on the 2563 change as the summaries describe it.

## To finish this check

Someone with access to `rd.go.th` can:

1. Open the two 2567 instruction PDFs above and confirm each row of the table.
2. Enter these returns in the Revenue Department calculator and compare with `reference/src/tax.js`: the "typical" and "family" cases in [`ui-check.mjs`](ui-check.mjs), plus one case per cap in [`hidden-tests.mjs`](hidden-tests.mjs).
3. Open an issue, or a pull request against the tests, with anything that differs. Every stored run can be re-scored in minutes with `python3 bench/thai-tax/score.py`.
