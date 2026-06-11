import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cheerio from 'cheerio'

const TARGET_YEARS = getTargetYears()

async function fetchTeamSeason(team, year, url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)
  const rosterRows = extractRows($, '#grid3')
  const hitterRows = extractRows($, '#grid1')
  const pitcherRows = extractRows($, '#grid2')
  const rosterMap = new Map(
    rosterRows.map((row) => [
      normalizeText(row.player),
      {
        position: row.pos ?? '',
        classYear: row.class ?? '',
      },
    ]),
  )
  const canonicalTeam = canonicalizeTeamName(team)
  const conferenceInfo = lookupConference(canonicalTeam)
  const players = []

  for (const row of hitterRows) {
    const roster = rosterMap.get(normalizeText(row.player))
    const eligiblePositions = getEligiblePositionsFromRoster(roster?.position ?? '')
    if (eligiblePositions.length === 0) {
      continue
    }

    players.push({
      id: `${year}-${normalizeText(team)}-${normalizeText(row.player)}-bat`,
      season: year,
      era: getEra(year),
      category: 'hitter',
      name: row.player,
      team: canonicalTeam,
      classYear: roster?.classYear || row.class || '',
      primaryPosition: eligiblePositions[0],
      eligiblePositions,
      teamTier: conferenceInfo.teamTier,
      conference: conferenceInfo.conference,
      stats: {
        games: toNumber(row.g),
        avg: toNumber(row.avg),
        ops: toNumber(row.ops),
        hr: toNumber(row.hr),
        rbi: toNumber(row.rbi),
        sb: toNumber(row.sb),
      },
      statLine: `${formatDecimal(row.avg, 3)} AVG - ${formatDecimal(row.ops, 3)} OPS - ${toNumber(row.hr)} HR`,
      source: 'thebaseballcube',
    })
  }

  for (const row of pitcherRows) {
    const roster = rosterMap.get(normalizeText(row.player))
    const eligiblePositions = classifyPitcherEligiblePositions(row)
    if (eligiblePositions.length === 0) {
      continue
    }

    players.push({
      id: `${year}-${normalizeText(team)}-${normalizeText(row.player)}-pit`,
      season: year,
      era: getEra(year),
      category: 'pitcher',
      name: row.player,
      team: canonicalTeam,
      classYear: roster?.classYear || row.class || '',
      primaryPosition: eligiblePositions[0],
      eligiblePositions,
      teamTier: conferenceInfo.teamTier,
      conference: conferenceInfo.conference,
      stats: {
        games: toNumber(row.g),
        wins: toNumber(row.w),
        era: toNumber(row.era),
        whip: toNumber(row.whip),
        strikeouts: toNumber(row.so),
        innings: toNumber(row.ip),
        saves: toNumber(row.sv),
        starts: toNumber(row.gs),
      },
      statLine: `${formatDecimal(row.era, 2)} ERA - ${formatDecimal(row.whip, 3)} WHIP - ${toNumber(row.so)} SO`,
      source: 'thebaseballcube',
    })
  }

  return players
}

function extractRows($, selector) {
  const headers = $(`${selector} tr`).first().find('th,td').map((_, cell) => $(cell).text().trim()).get()
  return $(`${selector} tr`)
    .slice(1)
    .map((_, row) => {
      const values = $(row).find('td').map((__, cell) => $(cell).text().trim()).get()
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    })
    .get()
    .filter((row) => row.player)
}

function classifyPitcherEligiblePositions(row) {
  const starts = toNumber(row.gs)
  const games = toNumber(row.g)
  const saves = toNumber(row.sv)
  if (games === 0) {
    return []
  }
  const eligible = []
  if (starts > 0) {
    eligible.push('SP')
  }
  if (saves > 0 || starts < games) {
    eligible.push('RP')
  }
  return eligible.length > 0 ? eligible : ['SP']
}

function getEligiblePositionsFromRoster(position) {
  const cleaned = decodeHtml(position).toUpperCase().replace(/\s+/g, '')
  const tokens = cleaned.split(/[-/]/).filter(Boolean)
  const mapped = new Set()

  for (const token of tokens) {
    if (token === 'C') mapped.add('C')
    if (token === '1B') mapped.add('1B')
    if (token === '2B') mapped.add('2B')
    if (token === '3B') mapped.add('3B')
    if (token === 'SS') mapped.add('SS')
    if (token === 'OF') ['LF', 'CF', 'RF'].forEach((entry) => mapped.add(entry))
    if (token === 'IF') ['1B', '2B', '3B', 'SS'].forEach((entry) => mapped.add(entry))
    if (token === 'LF') mapped.add('LF')
    if (token === 'CF') mapped.add('CF')
    if (token === 'RF') mapped.add('RF')
  }

  return Array.from(mapped)
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html',
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.text()
}

function lookupConference(team) {
  const normalized = normalizeText(canonicalizeTeamName(team))
  for (const [conference, teams] of Object.entries(CONFERENCE_TEAMS)) {
    if (teams.some((entry) => normalizeText(entry) === normalized)) {
      return {
        conference,
        teamTier: POWER_FIVE.has(conference) ? 'power5' : 'midMajor',
      }
    }
  }

  return {
    conference: 'Other Mid-Majors',
    teamTier: 'midMajor',
  }
}

function getEra(year) {
  if (year < 2000) return 'pre-2000s'
  if (year < 2010) return '2000s'
  if (year < 2020) return '2010s'
  return '2020s'
}

function toNumber(value) {
  return Number.parseFloat(`${value}`.trim()) || 0
}

function formatDecimal(value, digits) {
  return Number(toNumber(value)).toFixed(digits).replace(/^0(?=\.)/, '.')
}

function decodeHtml(value) {
  return `${value ?? ''}`
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function normalizeText(value) {
  return decodeHtml(value)
    .normalize('NFKD')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const POWER_FIVE = new Set(['ACC', 'Big 12', 'Big Ten', 'SEC'])

const CONFERENCE_TEAMS = {
  ACC: ['Boston College', 'California', 'Clemson', 'Duke', 'Florida State', 'Georgia Tech', 'Louisville', 'Miami', 'North Carolina', 'NC State', 'Notre Dame', 'Pittsburgh', 'Stanford', 'Virginia', 'Virginia Tech', 'Wake Forest'],
  'Big 12': ['Arizona', 'Arizona State', 'Baylor', 'Brigham Young', 'Cincinnati', 'Houston', 'Kansas', 'Kansas State', 'Oklahoma State', 'TCU', 'Texas Tech', 'UCF', 'Utah', 'West Virginia'],
  'Big Ten': ['Illinois', 'Indiana', 'Iowa', 'Maryland', 'Michigan', 'Michigan State', 'Minnesota', 'Nebraska', 'Northwestern', 'Ohio State', 'Oregon', 'Penn State', 'Purdue', 'Rutgers', 'Southern California', 'UCLA', 'Washington'],
  SEC: ['Alabama', 'Arkansas', 'Auburn', 'Florida', 'Georgia', 'Kentucky', 'LSU', 'Mississippi State', 'Missouri', 'Oklahoma', 'Ole Miss', 'South Carolina', 'Tennessee', 'Texas', 'Texas A&M', 'Vanderbilt'],
  'Sun Belt': ['Coastal Carolina', 'Georgia Southern', 'James Madison', 'Louisiana', 'Old Dominion', 'South Alabama', 'Southern Miss', 'Texas State', 'Troy', 'ULM'],
  AAC: ['Charlotte', 'East Carolina', 'Florida Atlantic', 'Memphis', 'Rice', 'South Florida', 'Tulane', 'UAB', 'UTSA', 'Wichita State'],
  'Conference USA': ['Dallas Baptist', 'Florida International', 'Jacksonville State', 'Kennesaw State', 'Liberty', 'Middle Tennessee', 'New Mexico State', 'Sam Houston', 'Western Kentucky'],
  'Atlantic 10': ['Dayton', 'George Mason', 'Rhode Island', "Saint Joseph's", 'VCU'],
  SoCon: ['Mercer', 'Samford', 'The Citadel', 'UNC Greensboro', 'Wofford'],
  WCC: ['Gonzaga', 'Loyola Marymount', 'Pepperdine', 'Portland', "Saint Mary's", 'San Diego', 'San Francisco'],
  BigWest: ['Cal Poly', 'CSU Bakersfield', 'CSUN', 'Hawaii', 'Long Beach State', 'UC Davis', 'UC Irvine', 'UC Riverside', 'UC San Diego', 'UC Santa Barbara'],
  MVC: ['Evansville', 'Illinois State', 'Indiana State', 'Missouri State', 'Murray State', 'Southern Illinois', 'UIC', 'Valparaiso'],
  Patriot: ['Army', 'Bucknell', 'Holy Cross', 'Lafayette', 'Lehigh', 'Navy'],
  MAC: ['Ball State', 'Bowling Green', 'Central Michigan', 'Eastern Michigan', 'Kent State', 'Miami (OH)', 'Northern Illinois', 'Ohio', 'Toledo', 'Western Michigan'],
  'Big South-OVC': ['Little Rock', 'Southeast Missouri State', 'SIU Edwardsville', 'Tennessee Tech', 'Western Illinois'],
}

async function main() {
  const targetTeams = buildTargetTeamLookup()
  const importsDir = join(process.cwd(), 'data', 'imports')
  const seasonsDir = join(importsDir, 'seasons')
  await mkdir(seasonsDir, { recursive: true })

  const seasons = []
  for (const year of TARGET_YEARS) {
    const yearPath = join(seasonsDir, `${year}.json`)
    const cached = await readCachedYear(yearPath)
    if (cached) {
      console.log(`Using cached ${year} season (${cached.players.length} players)`)
      seasons.push(cached)
      continue
    }

    console.log(`Fetching ${year} season index...`)
    const seasonHtml = await fetchHtml(`https://www.thebaseballcube.com/content/college_seasons/${year}/`)
    const season$ = cheerio.load(seasonHtml)
    const links = season$('a[href*="content/stats_college/"]')
      .map((_, element) => ({
        name: season$(element).text().trim(),
        href: new URL(season$(element).attr('href'), `https://www.thebaseballcube.com/content/college_seasons/${year}/`).toString(),
      }))
      .get()
      .map((entry) => ({
        ...entry,
        canonicalName: targetTeams.get(normalizeText(entry.name)),
      }))
      .filter((entry) => entry.canonicalName)

    console.log(`Found ${links.length} target teams for ${year}`)
    const players = []

    for (const link of links) {
      try {
        const teamPlayers = await fetchTeamSeason(link.canonicalName, year, link.href)
        players.push(...teamPlayers)
        console.log(`  ${year} ${link.canonicalName}: ${teamPlayers.length} players`)
      } catch (error) {
        console.log(`  ${year} ${link.canonicalName}: skipped (${error.message})`)
      }
    }

    const seasonRecord = { year, players }
    seasons.push(seasonRecord)
    await writeFile(yearPath, JSON.stringify(seasonRecord, null, 2))
  }

  const mergedSeasons = await readAllCachedSeasons(seasonsDir, seasons)
  const output = {
    generatedAt: new Date().toISOString(),
    seasons: mergedSeasons,
  }

  const outputPath = join(importsDir, 'historical-players.json')
  await writeFile(outputPath, JSON.stringify(output, null, 2))
  console.log(`Saved ${outputPath}`)
}

async function readCachedYear(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function readAllCachedSeasons(seasonsDir, updatedSeasons) {
  const updatedByYear = new Map(updatedSeasons.map((season) => [season.year, season]))
  const files = await readdir(seasonsDir)
  const cached = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const year = Number.parseInt(file.replace('.json', ''), 10)
    if (!Number.isFinite(year) || updatedByYear.has(year)) continue

    const season = await readCachedYear(join(seasonsDir, file))
    if (season) cached.push(season)
  }

  return [...updatedSeasons, ...cached].sort((left, right) => left.year - right.year)
}

function getTargetYears() {
  if (process.env.YEARS) {
    return process.env.YEARS.split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value))
  }

  const start = Number.parseInt(process.env.YEAR_START ?? '1970', 10)
  const end = Number.parseInt(process.env.YEAR_END ?? '2025', 10)
  const years = []
  for (let year = start; year <= end; year += 1) {
    years.push(year)
  }
  return years
}

function buildTargetTeamLookup() {
  const lookup = new Map()

  for (const team of Object.values(CONFERENCE_TEAMS).flat()) {
    for (const key of getTeamLookupKeys(team)) {
      if (!lookup.has(key)) lookup.set(key, team)
    }
  }

  return lookup
}

function canonicalizeTeamName(team) {
  const normalized = normalizeText(team)
  return TARGET_TEAM_ALIASES[normalized] ?? team
}

function getTeamLookupKeys(team) {
  const normalized = normalizeText(team)
  const aliases = TARGET_TEAM_ALIAS_KEYS[normalized] ?? []
  return Array.from(new Set([normalized, ...aliases]))
}

const TARGET_TEAM_ALIASES = {
  [normalizeText('USC')]: 'Southern California',
  [normalizeText('Mississippi')]: 'Ole Miss',
  [normalizeText('Central Florida')]: 'UCF',
  [normalizeText('Central Fla.')]: 'UCF',
  [normalizeText('Central Fla')]: 'UCF',
  [normalizeText('Oklahoma St.')]: 'Oklahoma State',
  [normalizeText('Kansas St.')]: 'Kansas State',
  [normalizeText('Illinois St.')]: 'Illinois State',
  [normalizeText('Missouri St.')]: 'Missouri State',
  [normalizeText('Texas St.')]: 'Texas State',
  [normalizeText('UC Santa Barbara')]: 'UC Santa Barbara',
  [normalizeText('UCSB')]: 'UC Santa Barbara',
  [normalizeText('St. John\'s (NY)')]: "St. John's",
  [normalizeText('Saint John\'s')]: "St. John's",
  [normalizeText('FGCU')]: 'Florida Gulf Coast',
  [normalizeText('UTSA')]: 'UTSA',
  [normalizeText('Texas at San Antonio')]: 'UTSA',
  [normalizeText('NC State')]: 'NC State',
  [normalizeText('North Carolina St.')]: 'NC State',
}

const TARGET_TEAM_ALIAS_KEYS = {
  [normalizeText('Southern California')]: [normalizeText('USC')],
  [normalizeText('Ole Miss')]: [normalizeText('Mississippi')],
  [normalizeText('UCF')]: [normalizeText('Central Florida'), normalizeText('Central Fla.'), normalizeText('Central Fla')],
  [normalizeText('Oklahoma State')]: [normalizeText('Oklahoma St.')],
  [normalizeText('Kansas State')]: [normalizeText('Kansas St.')],
  [normalizeText('Illinois State')]: [normalizeText('Illinois St.')],
  [normalizeText('Missouri State')]: [normalizeText('Missouri St.')],
  [normalizeText('Texas State')]: [normalizeText('Texas St.')],
  [normalizeText('UC Santa Barbara')]: [normalizeText('UCSB')],
  [normalizeText("St. John's")]: [normalizeText("St. John's (NY)"), normalizeText("Saint John's")],
  [normalizeText('Florida Gulf Coast')]: [normalizeText('FGCU')],
  [normalizeText('UTSA')]: [normalizeText('Texas at San Antonio')],
  [normalizeText('NC State')]: [normalizeText('North Carolina St.')],
}

await main()
