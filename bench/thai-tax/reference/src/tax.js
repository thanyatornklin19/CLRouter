// Reference: Thai personal income tax, tax year 2567, salary (40(1)) only.
// Proves the hidden tests; never shown to a model.

const BRACKETS = [
  [150000, 0],
  [300000, 0.05],
  [500000, 0.1],
  [750000, 0.15],
  [1000000, 0.2],
  [2000000, 0.25],
  [5000000, 0.3],
  [Infinity, 0.35],
]

export function progressiveTax(net) {
  let tax = 0
  let lower = 0
  for (const [upper, rate] of BRACKETS) {
    if (net > lower) tax += (Math.min(net, upper) - lower) * rate
    lower = upper
  }
  return Math.round(tax * 100) / 100
}

export function calculateTax(input) {
  const n = key => Number(input[key] ?? 0) || 0
  const salary = n('salary')
  const expense = Math.min(salary * 0.5, 100000)

  let allowances = 60000
  if (input.spouse) allowances += 60000
  const children = input.children ?? []
  children.forEach((year, i) => {
    allowances += i >= 1 && Number(year) >= 2561 ? 60000 : 30000
  })
  allowances += Math.min(Math.max(n('parents'), 0), 4) * 30000
  allowances += Math.min(n('socialSecurity'), 9000)
  allowances += Math.min(Math.min(n('lifeInsurance'), 100000) + Math.min(n('healthInsurance'), 25000), 100000)
  allowances += Math.min(n('parentsHealthInsurance'), 15000)
  const pvd = Math.min(n('providentFund'), salary * 0.15, 500000)
  const rmf = Math.min(n('rmf'), salary * 0.3, 500000)
  const ssf = Math.min(n('ssf'), salary * 0.3, 200000)
  allowances += Math.min(pvd + rmf + ssf, 500000)
  allowances += Math.min(n('homeLoanInterest'), 100000)

  const beforeDonation = Math.max(0, salary - expense - allowances)
  const donation = Math.min(n('donation'), beforeDonation * 0.1)
  allowances += donation

  const netIncome = Math.max(0, salary - expense - allowances)
  const tax = progressiveTax(netIncome)
  const refund = Math.round((n('withheld') - tax) * 100) / 100

  return { expense, allowances, netIncome, tax, refund }
}
