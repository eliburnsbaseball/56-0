import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cheerio from 'cheerio'

const year = Number(process.argv[2] ?? '2010')
const url = `https://www.thebaseballcube.com/content/college_seasons/${year}/`

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
const links = $('a[href*="/content/college_team/"]')
  .map((_, element) => ({
    name: $(element).text().trim(),
    href: new URL($(element).attr('href'), url).toString(),
  }))
  .get()

await mkdir(join(process.cwd(), 'data', 'imports'), { recursive: true })
const outputPath = join(process.cwd(), 'data', 'imports', `thebaseballcube-${year}-teams.json`)
await writeFile(outputPath, JSON.stringify({ year, url, links }, null, 2))
console.log(`Saved ${links.length} links to ${outputPath}`)
