import { chromium } from 'playwright'
import path from 'node:path'

const root = process.cwd()
const pdfPath = path.join(root, 'output', 'playwright', 'test-paper.pdf')
const screenshotPath = path.join(root, 'output', 'playwright', 'ui-verified.png')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } })

const consoleMessages = []
const apiResponses = []

page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleMessages.push(message.text())
  }
})
page.on('pageerror', (error) => {
  consoleMessages.push(error.message)
})
page.on('response', (response) => {
  const url = response.url()
  if (url.includes('/api/pdf-inspect') || url.includes('/api/pdf-index')) {
    apiResponses.push({ url, status: response.status() })
  }
})

await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })

await page.locator('input[accept="application/pdf,.pdf"]').setInputFiles(pdfPath)
await page.waitForFunction(() => document.body.innerText.includes('PDF 第 1 页预览'), null, {
  timeout: 15000,
})
await page.waitForFunction(() => document.body.innerText.includes('Figure 1'), null, {
  timeout: 15000,
})
await page.waitForFunction(() => document.body.innerText.includes('全文图谱'), null, {
  timeout: 15000,
})
await page.waitForFunction(() => document.body.innerText.includes('匹配到的 caption'), null, {
  timeout: 15000,
})

await page.getByRole('button', { name: /下一页/ }).click()
await page.waitForFunction(() => document.body.innerText.includes('PDF 第 2 页预览'), null, {
  timeout: 15000,
})

const pageInput = page.locator('.page-indicator input')
await pageInput.fill('1')
await pageInput.press('Enter')
await page.waitForFunction(() => document.body.innerText.includes('PDF 第 1 页预览'), null, {
  timeout: 15000,
})

const figureItems = await page.locator('.figure-index-item').count()
const evidenceCards = await page.locator('.evidence-card').count()
const failedApiResponses = apiResponses.filter((response) => response.status >= 400)

await page.screenshot({ path: screenshotPath, fullPage: true })
await browser.close()

if (figureItems < 1) {
  throw new Error('No figure index items rendered after PDF upload.')
}

if (evidenceCards < 1) {
  throw new Error('No evidence cards rendered after PDF upload.')
}

if (failedApiResponses.length > 0) {
  throw new Error(`PDF API errors:\n${JSON.stringify(failedApiResponses, null, 2)}`)
}

if (consoleMessages.length > 0) {
  throw new Error(`Browser console errors:\n${consoleMessages.join('\n')}`)
}

console.log(`UI verification passed: ${figureItems} figure items, ${evidenceCards} evidence cards.`)
