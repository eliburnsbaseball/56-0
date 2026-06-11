import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cheerio from 'cheerio'

const year = Number(process.argv[2] ?? '2026')
const type = process.argv[3] === 'pitch' ? 'pitch' : 'bat'
const url = `https://www.baseball-reference.com/register/leader.cgi?request=1&type=${type}&year=${year}&group=College`

const response = await fetch(url, {
  headers: {
    'user-agent': 'Mozilla/5.0',
    accept: 'text/html',
  },
})

if (!response.ok) {
  throw new Error(`Failed to fetch ${url}: ${response.status}`)
}

const html = await response.text()
const $ = cheerio.load(html)
const tableId = type === 'bat' ? '#year_batting' : '#year_pitching'
const headers = $(tableId)
  .find('thead th')
  .map((_, element) => $(element).text().trim())
  .get()
const rows = $(tableId)
  .find('tbody tr')
  .map((_, row) =>
    $(row)
      .find('th,td')
      .map((__, cell) => $(cell).text().trim())
      .get(),
  )
  .get()

await mkdir(join(process.cwd(), 'data', 'imports'), { recursive: true })
const outputPath = join(process.cwd(), 'data', 'imports', `baseball-reference-${year}-${type}.json`)
await writeFile(outputPath, JSON.stringify({ year, type, url, headers, rows }, null, 2))
console.log(`Saved ${rows.length} rows to ${outputPath}`)
