// Hidden acceptance tests: Thai personal income tax 2567, salary only.
// TAX_MODULE names the src/tax.js under test. Keep it away from the models you score.
import test from 'node:test'
import assert from 'node:assert'

const { calculateTax } = await import(process.env.TAX_MODULE)

const near = (actual, expected, label) =>
  assert.ok(Math.abs(Number(actual) - expected) < 0.01, `${label}: got ${actual}, want ${expected}`)
const taxOf = input => calculateTax(input).tax
const netOf = input => calculateTax(input).netIncome
// With salary >= 200,000: expense 100,000 + personal 60,000.
const salaryForNet = net => net + 160000

test('no income, no tax', () => {
  const r = calculateTax({ salary: 0 })
  near(r.tax, 0, 'tax')
  near(r.netIncome, 0, 'net')
})

test('expense is 50% of salary capped at 100,000', () => {
  near(calculateTax({ salary: 150000 }).expense, 75000, 'small salary')
  near(calculateTax({ salary: 1000000 }).expense, 100000, 'capped')
})

test('personal allowance 60,000', () => near(netOf({ salary: 300000 }), 140000, 'net'))

test('bracket boundaries', () => {
  const cases = [
    [150000, 0],
    [300000, 7500],
    [500000, 27500],
    [750000, 65000],
    [1000000, 115000],
    [2000000, 365000],
    [5000000, 1265000],
    [6000000, 1615000],
  ]
  for (const [net, tax] of cases) near(taxOf({ salary: salaryForNet(net) }), tax, `net ${net}`)
})

test('tax inside a bracket, with decimals', () => {
  near(taxOf({ salary: salaryForNet(300001) }), 7500.1, 'net 300,001')
  near(taxOf({ salary: salaryForNet(431000) }), 20600, 'net 431,000')
})

test('typical salaried worker', () => near(taxOf({ salary: 600000, socialSecurity: 9000 }), 20600, 'tax'))

test('social security capped at 9,000', () =>
  near(netOf({ salary: 600000, socialSecurity: 12000 }), 431000, 'net'))

test('spouse and parents', () => {
  near(netOf({ salary: 600000, spouse: true }), 380000, 'spouse')
  near(netOf({ salary: 600000, parents: 2 }), 380000, 'two parents')
})

test('children: 30,000, or 60,000 from the 2nd child born 2561 or later', () => {
  const base = 440000
  near(netOf({ salary: 600000, children: [2558] }), base - 30000, 'one child')
  near(netOf({ salary: 600000, children: [2562] }), base - 30000, 'first child born 2562')
  near(netOf({ salary: 600000, children: [2558, 2562] }), base - 90000, 'second born 2562')
  near(netOf({ salary: 600000, children: [2555, 2560] }), base - 60000, 'second born 2560')
  near(netOf({ salary: 600000, children: [2562, 2563, 2564] }), base - 150000, 'three from 2562')
})

test('life insurance capped at 100,000', () =>
  near(netOf({ salary: 600000, lifeInsurance: 120000 }), 340000, 'net'))

test('health insurance 25,000, life + health together 100,000', () => {
  near(netOf({ salary: 600000, lifeInsurance: 50000, healthInsurance: 20000 }), 370000, 'under caps')
  near(netOf({ salary: 600000, healthInsurance: 30000 }), 415000, 'health capped')
  near(netOf({ salary: 600000, lifeInsurance: 90000, healthInsurance: 30000 }), 340000, 'combined capped')
})

test("parents' health insurance capped at 15,000", () =>
  near(netOf({ salary: 600000, parentsHealthInsurance: 20000 }), 425000, 'net'))

test('provident fund capped at 15% of salary', () =>
  near(netOf({ salary: 1000000, providentFund: 200000 }), 690000, 'net'))

test('RMF capped at 30% of salary', () => near(netOf({ salary: 1000000, rmf: 400000 }), 540000, 'net'))

test('SSF capped at 200,000', () => near(netOf({ salary: 1000000, ssf: 300000 }), 640000, 'net'))

test('PVD + RMF + SSF together capped at 500,000', () =>
  near(netOf({ salary: 3000000, providentFund: 450000, rmf: 300000 }), 2340000, 'net'))

test('home loan interest capped at 100,000', () =>
  near(netOf({ salary: 600000, homeLoanInterest: 150000 }), 340000, 'net'))

test('donation capped at 10% of income after other deductions', () => {
  near(netOf({ salary: 1000000, donation: 10000 }), 830000, 'under cap')
  near(netOf({ salary: 1000000, donation: 200000 }), 756000, 'capped')
})

test('refund or tax payable', () => {
  near(calculateTax({ salary: 600000, socialSecurity: 9000, withheld: 30000 }).refund, 9400, 'refund')
  near(calculateTax({ salary: 600000, socialSecurity: 9000, withheld: 10000 }).refund, -10600, 'payable')
})

test('a full return', () => {
  const r = calculateTax({
    salary: 1200000,
    withheld: 100000,
    spouse: true,
    children: [2559, 2562],
    parents: 2,
    socialSecurity: 9000,
    lifeInsurance: 80000,
    healthInsurance: 30000,
    providentFund: 100000,
    rmf: 100000,
    homeLoanInterest: 120000,
    donation: 20000,
  })
  near(r.netIncome, 401000, 'net')
  near(r.tax, 17600, 'tax')
  near(r.refund, 82400, 'refund')
})
