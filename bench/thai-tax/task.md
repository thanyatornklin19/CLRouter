Build a web app that calculates Thai personal income tax for tax year 2567 (2024) for a salaried employee (income type 40(1) only). No build step, no dependencies.

- `src/tax.js`: an ES module exporting `calculateTax(input)`.
  - input: `{ salary, withheld, spouse, children, parents, socialSecurity, lifeInsurance, healthInsurance, parentsHealthInsurance, providentFund, rmf, ssf, homeLoanInterest, donation }`. Amounts are what was earned or paid in the year, in baht. `spouse` is true for a spouse with no income. `children` is an array of birth years in พ.ศ., in birth order. `parents` is the number of qualifying parents (0-4). A missing field means 0 or none.
  - returns `{ expense, allowances, netIncome, tax, refund }`: the expense deduction, all other deductions together, net taxable income, the tax due rounded to satang, and `refund = withheld - tax` (negative means tax payable).
  - Apply the real Thai rules for 2567: the expense deduction, every allowance with its legal cap, and the progressive rates.
- `index.html`: a page in Thai that uses `src/tax.js`. It has inputs whose ids equal the input keys (`#spouse` is a checkbox, `#children` a text field of comma-separated birth years), a button `#calculate`, and the results in `#netIncome`, `#tax` and `#refund`.
- Tests run with `node --test`.
