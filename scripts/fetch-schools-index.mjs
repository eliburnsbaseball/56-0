import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputDir = join(process.cwd(), 'data', 'raw')
const outputPath = join(outputDir, 'schools-index.json')

const response = await fetch('https://ncaa-api.henrygd.me/schools-index', {
  headers: {
    'user-agent': 'Mozilla/5.0',
    accept: 'application/json',
  },
})

if (!response.ok) {
  throw new Error(`Failed to fetch schools index: ${response.status}`)
}

await mkdir(outputDir, { recursive: true })
await writeFile(outputPath, await response.text(), 'utf8')
console.log(`Saved ${outputPath}`)
