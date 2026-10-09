// Opens the built page in a real browser, fills the form, presses calculate
// and reads the result. Usage: node ui-check.mjs <app dir> <screenshot.png>
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'

// Playwright from this project if installed, else from the global npm root.
async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    const root = execSync('npm root -g').toString().trim()
    return createRequire(`${root}/`)('playwright')
  }
}
const { chromium } = await loadPlaywright()

const [dir, shot] = process.argv.slice(2)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '')
  try {
    const body = await readFile(join(dir, path || 'index.html'))
    res.writeHead(200, { 'content-type': TYPES[extname(path || 'index.html')] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
}).listen(0)
const port = server.address().port

const CASES = [
  { name: 'typical', fill: { salary: 600000, socialSecurity: 9000, withheld: 30000 }, want: { netIncome: 431000, tax: 20600, refund: 9400 } },
  {
    name: 'family',
    fill: { salary: 1200000, withheld: 100000, parents: 2, socialSecurity: 9000, lifeInsurance: 80000, healthInsurance: 30000,
      providentFund: 100000, rmf: 100000, homeLoanInterest: 120000, donation: 20000, children: '2559, 2562' },
    spouse: true,
    want: { netIncome: 401000, tax: 17600, refund: 82400 },
  },
]

const parse = text => Number(String(text).replace(/[^\d.\-]/g, ''))
const results = []
const browser = await chromium.launch()
try {
  for (const c of CASES) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1300 } })
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))
    let ok = false
    let detail = ''
    try {
      await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load', timeout: 10000 })
      for (const [id, v] of Object.entries(c.fill)) await page.fill(`#${id}`, String(v), { timeout: 3000 })
      if (c.spouse) await page.check('#spouse', { timeout: 3000 })
      await page.click('#calculate', { timeout: 3000 })
      await page.waitForTimeout(300)
      const got = {}
      for (const k of Object.keys(c.want)) got[k] = parse(await page.textContent(`#${k}`, { timeout: 3000 }))
      ok = Object.entries(c.want).every(([k, v]) => Math.abs(got[k] - v) < 0.01)
      detail = JSON.stringify(got)
      if (c.name === 'family' && shot) await page.screenshot({ path: shot, fullPage: true })
    } catch (e) {
      detail = String(e).split('\n')[0]
    }
    results.push({ case: c.name, ok, detail, errors })
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}
console.log(JSON.stringify(results))
