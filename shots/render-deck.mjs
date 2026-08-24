import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage()
await p.goto('file://' + process.argv[2], { waitUntil: 'networkidle' })
await p.pdf({ path: process.argv[3], width: '1280px', height: '720px', printBackground: true })
await b.close()
console.log('rendered')
