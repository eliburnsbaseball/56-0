import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const rosterSlots = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'SP', 'SP', 'SP', 'RP', 'RP']
const advancedPath = join(process.cwd(), 'data', 'raw', '2026-advanced.csv')
const hitterPath = join(process.cwd(), 'data', 'raw', '2026-hitters.csv')
const pitcherPath = join(process.cwd(), 'data', 'raw', '2026-pitchers.csv')
const schoolsPath = join(process.cwd(), 'data', 'raw', 'schools-index.json')
const historicalPath = join(process.cwd(), 'data', 'imports', 'historical-players.json')

const hitterFeatures = ['PA', 'BA', 'OBP', 'SLG', 'OPS', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'HBP', 'BB', 'K', 'SB', 'CS']
const pitcherFeatures = ['APP', 'GS', 'SV', 'IP', 'ERA', 'H', 'ER', 'BB', 'K', 'HBP', 'BA', 'W', 'L']
const PLAYER_CHUNK_TARGET_BYTES = 9_500_000

async function main() {
  const schools = JSON.parse(await readFile(schoolsPath, 'utf8'))
  const schoolLookup = buildSchoolLookup(schools)
  const historical = await readHistoricalPlayers(schoolLookup)
  const advancedRows = parseCsv(await readFile(advancedPath, 'utf8')).filter((row) => row.Player)
  const hitterRows = parseCsv(await readFile(hitterPath, 'utf8'))
  const pitcherRows = parseCsv(await readFile(pitcherPath, 'utf8'))

  const advancedMap = new Map()
  for (const row of advancedRows) {
    advancedMap.set(`${normalizeText(row.Player)}|${normalizeText(row.Team)}`, row)
  }

  const hitterTraining = []
  const pitcherTraining = []

  for (const row of hitterRows) {
    const advanced = advancedMap.get(`${normalizeText(row.Player)}|${normalizeText(row.Team)}`)
    if (!advanced || advanced.Position === 'P') continue
    hitterTraining.push({
      features: hitterFeatures.map((feature) => numberValue(row[feature])),
      target: numberValue(advanced.oWAR),
    })
  }

  for (const row of pitcherRows) {
    const advanced = advancedMap.get(`${normalizeText(row.Player)}|${normalizeText(row.Team)}`)
    if (!advanced || advanced.Position !== 'P') continue
    pitcherTraining.push({
      features: pitcherFeatures.map((feature) => numberValue(row[feature])),
      target: numberValue(advanced.pWAR),
    })
  }

  const hitterModel = fitRidgeModel(hitterTraining, 0.4)
  const pitcherModel = fitRidgeModel(pitcherTraining, 0.6)

  const currentPlayers = [
    ...hitterRows.map((row) => buildCurrentHitter(row, hitterModel, schoolLookup)),
    ...pitcherRows.map((row) => buildCurrentPitcher(row, pitcherModel, schoolLookup)),
  ]

  const players = aggregateCareers([...historical, ...currentPlayers], schoolLookup).sort(
    (left, right) => right.value - left.value,
  )
  const eras = ['pre-2000s', '2000s', '2010s', '2020s'].filter((era) =>
    players.some((player) => player.era === era),
  )

  const meta = {
    generatedAt: new Date().toISOString(),
    rosterSlots,
    availableEras: eras,
    positionFilters: ['ALL', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'SP', 'RP'],
    sortOptions: ['rating', 'games', 'avg', 'ops', 'hr', 'rbi', 'era', 'whip', 'so'],
    playerChunks: [],
    modelDiagnostics: {
      hitter: {
        trainingRows: hitterTraining.length,
        r2: hitterModel.r2,
        features: hitterFeatures,
      },
      pitcher: {
        trainingRows: pitcherTraining.length,
        r2: pitcherModel.r2,
        features: pitcherFeatures,
      },
      historicalPlayers: players.filter((player) => player.source === 'career-aggregate-historical').length,
    },
  }

  const publicDataDir = join(process.cwd(), 'public', 'data')
  await mkdir(publicDataDir, { recursive: true })
  await rm(join(publicDataDir, 'players.generated.json'), { force: true })

  const chunks = chunkPlayers(players, PLAYER_CHUNK_TARGET_BYTES)
  meta.playerChunks = await Promise.all(
    chunks.map(async (chunk, index) => {
      const fileName = `players.generated.${String(index + 1).padStart(2, '0')}.json`
      await writeFile(join(publicDataDir, fileName), JSON.stringify(chunk))
      return fileName
    }),
  )

  await writeFile(join(publicDataDir, 'meta.generated.json'), JSON.stringify(meta))

  console.log(
    `Generated ${players.length} career players in ${meta.playerChunks.length} chunks (${historical.length} historical seasons, ${currentPlayers.length} current seasons)`,
  )
}

function chunkPlayers(players, targetBytes) {
  const chunks = []
  let currentChunk = []
  let currentBytes = 2

  for (const player of players) {
    const serialized = JSON.stringify(player)
    const serializedBytes = Buffer.byteLength(serialized)
    const separatorBytes = currentChunk.length > 0 ? 1 : 0

    if (currentChunk.length > 0 && currentBytes + serializedBytes + separatorBytes > targetBytes) {
      chunks.push(currentChunk)
      currentChunk = [player]
      currentBytes = 2 + serializedBytes
      continue
    }

    currentChunk.push(player)
    currentBytes += serializedBytes + separatorBytes
  }

  if (currentChunk.length > 0) chunks.push(currentChunk)
  return chunks
}

async function readHistoricalPlayers(schoolLookup) {
  try {
    const historical = JSON.parse(await readFile(historicalPath, 'utf8'))
    return historical.seasons
      .flatMap((season) => season.players)
      .filter((player) => !/totals/i.test(player.name))
      .filter((player) => isUsableHistoricalPlayer(player))
      .map((player) => enrichHistoricalPlayer(player, schoolLookup))
  } catch {
    return []
  }
}

function isUsableHistoricalPlayer(player) {
  if (player.category === 'pitcher') {
    const games = player.stats.games || 0
    const starts = player.stats.starts || 0
    const era = player.stats.era || 0
    const whip = player.stats.whip || 0
    const innings = player.stats.innings || 0

    if (starts > games && games > 0) return false
    if (era > 40 || whip > 8) return false
    if (innings <= 1 && starts >= 3) return false
  }

  if (player.category === 'hitter') {
    const avg = player.stats.avg || 0
    const ops = player.stats.ops || 0

    if (avg > 0.6 || ops > 2.4) return false
  }

  return true
}

function enrichHistoricalPlayer(player, schoolLookup) {
  const rawRating = player.category === 'pitcher' ? scoreHistoricalPitcher(player.stats) : scoreHistoricalHitter(player.stats)
  const rating = player.category === 'pitcher' ? Math.max(-1.75, rawRating) : rawRating
  return {
    ...player,
    logoSlug: findSchoolSlug(player.team, schoolLookup),
    value: roundTo(rating, 2),
  }
}

function buildCurrentHitter(row, model, schoolLookup) {
  const team = decodeHtml(row.Team)
  const primaryPosition = normalizeCurrentHitterPosition(row.POS)
  const eligiblePositions = getEligibleCurrentHitterPositions(primaryPosition)
  const conferenceInfo = lookupConference(team)

  return {
    id: `2026-${normalizeText(row.Player)}-${normalizeText(team)}-${primaryPosition}`,
    season: 2026,
    era: '2020s',
    category: 'hitter',
    name: decodeHtml(row.Player),
    team,
    classYear: row.Class,
    primaryPosition,
    eligiblePositions,
    teamTier: conferenceInfo.teamTier,
    conference: conferenceInfo.conference,
    value: roundTo(estimate(model, hitterFeatures.map((feature) => numberValue(row[feature]))), 2),
    logoSlug: findSchoolSlug(team, schoolLookup),
    stats: {
      games: numberValue(row.GP),
      avg: numberValue(row.BA),
      ops: numberValue(row.OPS),
      hr: numberValue(row.HR),
      rbi: numberValue(row.RBI),
      sb: numberValue(row.SB),
    },
    statLine: `${formatDecimal(row.BA, 3)} AVG - ${formatDecimal(row.OPS, 3)} OPS - ${row.HR} HR`,
    source: '2026-csv',
  }
}

function aggregateCareers(players, schoolLookup) {
  const grouped = new Map()

  for (const player of [...players].sort((left, right) => left.season - right.season)) {
    const key = `${normalizeText(player.name)}|${player.category}|${normalizeText(player.team)}`
    const entries = grouped.get(key) ?? []
    entries.push(player)
    grouped.set(key, entries)
  }

  return Array.from(grouped.values()).flatMap((entries) => {
    const sorted = [...entries].sort((left, right) => left.season - right.season)
    const clusters = []

    for (const player of sorted) {
      const cluster = clusters.at(-1)
      const extendsBeyondCareerWindow =
        cluster &&
        (player.season - cluster.lastSeason > 2 ||
          player.season - cluster.firstSeason > 5 ||
          (!cluster.seasons.has(player.season) && cluster.seasons.size >= 6))

      if (!cluster || extendsBeyondCareerWindow) {
        clusters.push({ players: [player], firstSeason: player.season, lastSeason: player.season, seasons: new Set([player.season]) })
        continue
      }
      cluster.players.push(player)
      cluster.lastSeason = player.season
      cluster.seasons.add(player.season)
    }

    return clusters.map((cluster, index) => aggregateCareerCluster(cluster.players, schoolLookup, index))
  })
}

function aggregateCareerCluster(players, schoolLookup, clusterIndex) {
  const sorted = [...players].sort((left, right) => left.season - right.season)
  const seasonStart = sorted[0].season
  const seasonEnd = sorted[sorted.length - 1].season
  const seasonCount = new Set(sorted.map((player) => player.season)).size
  const rawEligiblePositions = Array.from(new Set(sorted.flatMap((player) => player.eligiblePositions)))
  const primaryPosition = getPrimaryCareerPosition(sorted, rawEligiblePositions)
  const eligiblePositions = normalizeCareerEligiblePositions(sorted, rawEligiblePositions, primaryPosition)
  const representative = pickRepresentativeSeason(sorted)
  const dominantTeam = pickDominantTeam(sorted)
  const dominantEra = pickDominantEra(sorted)
  const stats = representative.category === 'pitcher' ? aggregatePitcherStats(sorted) : aggregateHitterStats(sorted)
  const value = roundTo(sorted.reduce((sum, player) => sum + (player.value || 0), 0), 2)

  return {
    id: `career-${normalizeText(representative.name)}-${normalizeText(dominantTeam.team)}-${representative.category}-${seasonStart}-${clusterIndex}`,
    season: seasonEnd,
    seasonStart,
    seasonEnd,
    seasonCount,
    era: dominantEra,
    category: representative.category,
    name: representative.name,
    team: dominantTeam.team,
    classYear: pickCareerClassYear(sorted),
    primaryPosition,
    eligiblePositions,
    teamTier: dominantTeam.teamTier,
    conference: dominantTeam.conference,
    value,
    logoSlug: findSchoolSlug(dominantTeam.team, schoolLookup) ?? dominantTeam.logoSlug ?? null,
    stats,
    statLine: representative.category === 'pitcher' ? buildPitcherStatLine(stats) : buildHitterStatLine(stats),
    source: sorted.every((player) => player.source === 'thebaseballcube') ? 'career-aggregate-historical' : 'career-aggregate',
  }
}

function pickRepresentativeSeason(players) {
  return [...players].sort((left, right) => right.value - left.value || right.season - left.season)[0]
}

function pickDominantTeam(players) {
  const totals = new Map()

  for (const player of players) {
    const current = totals.get(player.team) ?? {
      team: player.team,
      teamTier: player.teamTier,
      conference: player.conference,
      logoSlug: player.logoSlug ?? null,
      weight: 0,
    }

    current.weight += getCareerWeight(player)
    if (!current.logoSlug && player.logoSlug) current.logoSlug = player.logoSlug
    totals.set(player.team, current)
  }

  return [...totals.values()].sort((left, right) => right.weight - left.weight || left.team.localeCompare(right.team))[0]
}

function pickDominantEra(players) {
  const totals = new Map()

  for (const player of players) {
    totals.set(player.era, (totals.get(player.era) ?? 0) + getCareerWeight(player))
  }

  return [...totals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? getEra(players[0].season)
}

function getCareerWeight(player) {
  if (player.category === 'pitcher') {
    return player.stats.innings || player.stats.games || player.value || 0
  }

  return player.stats.games || player.value || 0
}

function getPrimaryCareerPosition(players, eligiblePositions) {
  const counts = new Map(eligiblePositions.map((position) => [position, 0]))

  for (const player of players) {
    for (const position of player.eligiblePositions) {
      counts.set(position, (counts.get(position) ?? 0) + 1)
    }
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? eligiblePositions[0]
}

function normalizeCareerEligiblePositions(players, eligiblePositions, primaryPosition) {
  if (players[0]?.category === 'pitcher') {
    return eligiblePositions
  }

  const hasInfield = eligiblePositions.some((position) => ['1B', '2B', '3B', 'SS'].includes(position))
  const hasOutfield = eligiblePositions.some((position) => ['LF', 'CF', 'RF'].includes(position))

  if (eligiblePositions.length > 4 || (hasInfield && hasOutfield)) {
    return [primaryPosition]
  }

  return eligiblePositions
}

function pickCareerClassYear(players) {
  const ranked = [...players]
    .map((player) => player.classYear)
    .filter(Boolean)
    .sort((left, right) => rankClassYear(right) - rankClassYear(left))

  return ranked[0] ?? ''
}

function rankClassYear(value) {
  const normalized = normalizeText(value)
  if (normalized === 'sr' || normalized === 'senior' || normalized === 'gr') return 4
  if (normalized === 'jr' || normalized === 'junior') return 3
  if (normalized === 'so' || normalized === 'sophomore') return 2
  if (normalized === 'fr' || normalized === 'freshman') return 1
  return 0
}

function aggregateHitterStats(players) {
  const totals = {
    games: 0,
    avg: 0,
    ops: 0,
    hr: 0,
    rbi: 0,
    sb: 0,
  }
  let avgWeight = 0
  let opsWeight = 0

  for (const player of players) {
    const games = player.stats.games || 0
    totals.games += games
    totals.hr += player.stats.hr || 0
    totals.rbi += player.stats.rbi || 0
    totals.sb += player.stats.sb || 0
    totals.avg += (player.stats.avg || 0) * games
    totals.ops += (player.stats.ops || 0) * games
    avgWeight += games
    opsWeight += games
  }

  totals.avg = roundTo(avgWeight ? totals.avg / avgWeight : 0, 3)
  totals.ops = roundTo(opsWeight ? totals.ops / opsWeight : 0, 3)
  return totals
}

function aggregatePitcherStats(players) {
  const totals = {
    games: 0,
    wins: 0,
    era: 0,
    whip: 0,
    strikeouts: 0,
    innings: 0,
    saves: 0,
    starts: 0,
  }
  let eraWeight = 0
  let whipWeight = 0

  for (const player of players) {
    const innings = player.stats.innings || 0
    const games = player.stats.games || 0
    const weight = innings || games
    totals.games += games
    totals.wins += player.stats.wins || 0
    totals.strikeouts += player.stats.strikeouts || 0
    totals.innings += innings
    totals.saves += player.stats.saves || 0
    totals.starts += player.stats.starts || 0
    totals.era += (player.stats.era || 0) * weight
    totals.whip += (player.stats.whip || 0) * weight
    eraWeight += weight
    whipWeight += weight
  }

  totals.era = roundTo(eraWeight ? totals.era / eraWeight : 0, 2)
  totals.whip = roundTo(whipWeight ? totals.whip / whipWeight : 0, 3)
  totals.innings = roundTo(totals.innings, 1)
  return totals
}

function buildHitterStatLine(stats) {
  return `${formatDecimal(stats.avg, 3)} AVG - ${formatDecimal(stats.ops, 3)} OPS - ${Math.round(stats.hr || 0)} HR`
}

function buildPitcherStatLine(stats) {
  return `${formatDecimal(stats.era, 2)} ERA - ${formatDecimal(stats.whip, 3)} WHIP - ${Math.round(stats.strikeouts || 0)} SO`
}

function buildCurrentPitcher(row, model, schoolLookup) {
  const team = decodeHtml(row.Team)
  const eligiblePositions = classifyCurrentPitcherPositions(row)
  const conferenceInfo = lookupConference(team)

  return {
    id: `2026-${normalizeText(row.Player)}-${normalizeText(team)}-pitch`,
    season: 2026,
    era: '2020s',
    category: 'pitcher',
    name: decodeHtml(row.Player),
    team,
    classYear: row.Class,
    primaryPosition: eligiblePositions[0],
    eligiblePositions,
    teamTier: conferenceInfo.teamTier,
    conference: conferenceInfo.conference,
    value: roundTo(estimate(model, pitcherFeatures.map((feature) => numberValue(row[feature]))), 2),
    logoSlug: findSchoolSlug(team, schoolLookup),
    stats: {
      games: numberValue(row.APP),
      wins: numberValue(row.W),
      era: numberValue(row.ERA),
      whip: estimateWhip(row),
      strikeouts: numberValue(row.K),
      innings: numberValue(row.IP),
      saves: numberValue(row.SV),
      starts: numberValue(row.GS),
    },
    statLine: `${formatDecimal(row.ERA, 2)} ERA - ${formatDecimal(estimateWhip(row), 3)} WHIP - ${row.K} SO`,
    source: '2026-csv',
  }
}

function scoreHistoricalHitter(stats) {
  return (
    (stats.ops || 0) * 2.5 +
    (stats.avg || 0) * 1.2 +
    (stats.hr || 0) * 0.045 +
    (stats.rbi || 0) * 0.018 +
    (stats.sb || 0) * 0.012 +
    (stats.games || 0) * 0.002
  )
}

function scoreHistoricalPitcher(stats) {
  const innings = stats.innings || 0
  const strikeouts = stats.strikeouts || 0
  const strikeoutRate = innings > 0 ? strikeouts / innings : 0
  const starterBonus = (stats.starts || 0) * 0.018
  const reliefBonus = (stats.saves || 0) * 0.03

  return (
    innings * 0.008 +
    strikeouts * 0.013 +
    strikeoutRate * 1.4 +
    (stats.wins || 0) * 0.055 +
    starterBonus +
    reliefBonus -
    (stats.era || 0) * 0.32 -
    (stats.whip || 0) * 0.45 +
    1.65
  )
}

function getEra(year) {
  if (year < 2000) return 'pre-2000s'
  if (year < 2010) return '2000s'
  if (year < 2020) return '2010s'
  return '2020s'
}

function classifyCurrentPitcherPositions(row) {
  const starts = numberValue(row.GS)
  const appearances = numberValue(row.APP)
  const saves = numberValue(row.SV)
  const eligible = []
  if (starts > 0) eligible.push('SP')
  if (saves >= 1 || starts < appearances) eligible.push('RP')
  return eligible.length > 0 ? eligible : ['SP']
}

function estimateWhip(row) {
  const innings = numberValue(row.IP)
  if (!innings) return 0
  return roundTo((numberValue(row.H) + numberValue(row.BB)) / innings, 3)
}

function getEligibleCurrentHitterPositions(position) {
  if (['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'].includes(position)) return [position]
  if (position === 'OF') return ['LF', 'CF', 'RF']
  return []
}

function normalizeCurrentHitterPosition(position) {
  const value = decodeHtml(position).trim().toUpperCase()
  if (value.includes('/')) return normalizeCurrentHitterPosition(value.split('/')[0])
  return value
}

function lookupConference(team) {
  const normalized = normalizeText(team)
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

function findSchoolSlug(team, schoolLookup) {
  const candidateKeys = getTeamLookupKeys(team)

  for (const key of candidateKeys) {
    if (schoolLookup.has(key)) return schoolLookup.get(key)
  }

  return null
}

function buildSchoolLookup(schoolIndex) {
  const lookup = new Map()
  for (const school of schoolIndex) {
    const keys = [school.name, school.long]
      .filter(Boolean)
      .flatMap((entry) => getTeamLookupKeys(entry))
    for (const key of keys) {
      if (!lookup.has(key)) lookup.set(key, school.slug)
    }
  }
  return lookup
}

function getTeamLookupKeys(team) {
  const normalized = normalizeText(team)
  const canonical = normalizeSchoolKey(team)
  const aliases = TEAM_ALIASES[normalized] ?? []
  return Array.from(new Set([normalized, canonical, ...aliases]))
}

function normalizeSchoolKey(value) {
  return normalizeText(value)
    .replace(/\buniversity of\b/g, '')
    .replace(/\bstate\b/g, 'st')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bmount\b/g, 'mt')
    .replace(/\btexas at\b/g, '')
    .replace(/\bat\b/g, '')
    .replace(/\bnorth\b/g, 'n')
    .replace(/\bsouth\b/g, 's')
    .replace(/\beast\b/g, 'e')
    .replace(/\bwest\b/g, 'w')
    .replace(/\s+/g, ' ')
    .trim()
}

function fitRidgeModel(rows, lambda) {
  const featureCount = rows[0].features.length
  const means = Array(featureCount).fill(0)
  const stdDevs = Array(featureCount).fill(0)

  for (const row of rows) {
    row.features.forEach((value, index) => {
      means[index] += value
    })
  }
  for (let index = 0; index < featureCount; index += 1) means[index] /= rows.length

  for (const row of rows) {
    row.features.forEach((value, index) => {
      stdDevs[index] += (value - means[index]) ** 2
    })
  }
  for (let index = 0; index < featureCount; index += 1) stdDevs[index] = Math.sqrt(stdDevs[index] / rows.length) || 1

  const x = rows.map((row) => [1, ...row.features.map((value, index) => (value - means[index]) / stdDevs[index])])
  const y = rows.map((row) => row.target)
  const xt = transpose(x)
  const xtx = multiply(xt, x)
  for (let index = 1; index < xtx.length; index += 1) xtx[index][index] += lambda

  const weights = multiplyVector(invert(xtx), multiplyVector(xt, y))
  const predictions = rows.map((row) => estimate({ intercept: weights[0], weights: weights.slice(1), means, stdDevs }, row.features))
  const meanTarget = y.reduce((sum, value) => sum + value, 0) / y.length
  const ssRes = predictions.reduce((sum, value, index) => sum + (y[index] - value) ** 2, 0)
  const ssTot = y.reduce((sum, value) => sum + (value - meanTarget) ** 2, 0)

  return { intercept: weights[0], weights: weights.slice(1), means, stdDevs, r2: 1 - ssRes / ssTot }
}

function estimate(model, values) {
  return model.intercept + values.reduce((sum, value, index) => sum + ((value - model.means[index]) / model.stdDevs[index]) * model.weights[index], 0)
}

function transpose(matrix) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]))
}

function multiply(left, right) {
  return left.map((row) => right[0].map((_, column) => row.reduce((sum, value, index) => sum + value * right[index][column], 0)))
}

function multiplyVector(matrix, vector) {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0))
}

function invert(matrix) {
  const size = matrix.length
  const augmented = matrix.map((row, index) => [...row, ...Array.from({ length: size }, (_, column) => (column === index ? 1 : 0))])

  for (let column = 0; column < size; column += 1) {
    let pivot = column
    while (pivot < size && Math.abs(augmented[pivot][column]) < 1e-10) pivot += 1
    if (pivot !== column) [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]

    const pivotValue = augmented[column][column]
    for (let index = 0; index < size * 2; index += 1) augmented[column][index] /= pivotValue

    for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
      if (rowIndex === column) continue
      const factor = augmented[rowIndex][column]
      for (let index = 0; index < size * 2; index += 1) augmented[rowIndex][index] -= factor * augmented[column][index]
    }
  }

  return augmented.map((row) => row.slice(size))
}

function parseCsv(text) {
  const rows = []
  let current = ''
  let row = []
  let inQuotes = false

  const pushValue = () => {
    row.push(current)
    current = ''
  }
  const pushRow = () => {
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (character === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (character === ',' && !inQuotes) {
      pushValue()
      continue
    }
    if ((character === '\n' || character === '\r') && !inQuotes) {
      if (character === '\r' && next === '\n') index += 1
      pushValue()
      pushRow()
      continue
    }
    current += character
  }

  if (current.length > 0 || row.length > 0) {
    pushValue()
    pushRow()
  }

  const [headers, ...records] = rows.filter((record) => record.length > 1 || record[0])
  return records
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])))
    .filter((record) => Object.values(record).some(Boolean))
}

function numberValue(value) {
  return Number.parseFloat(`${value}`.trim()) || 0
}

function formatDecimal(value, digits) {
  return Number(numberValue(value)).toFixed(digits).replace(/^0(?=\.)/, '.')
}

function roundTo(value, digits) {
  const power = 10 ** digits
  return Math.round(value * power) / power
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

const TEAM_ALIASES = {
  [normalizeText('Arizona State')]: [normalizeText('Arizona St.')],
  [normalizeText('Southern California')]: [normalizeText('USC')],
  [normalizeText('Miami')]: [normalizeText('Miami (FL)')],
  [normalizeText("Saint Mary's")]: [normalizeText('Saint Marys')],
  [normalizeText('UC Santa Barbara')]: [normalizeText('UCSB')],
  [normalizeText('Miami (OH)')]: [normalizeText('Miami Ohio')],
  [normalizeText('Oklahoma State')]: [normalizeText('Oklahoma St.')],
  [normalizeText('Illinois State')]: [normalizeText('Illinois St.')],
  [normalizeText('Kansas State')]: [normalizeText('Kansas St.')],
  [normalizeText('San Jose State')]: [normalizeText('San Jose St.')],
  [normalizeText('Tennessee-Martin')]: [normalizeText('Tenn-Martin'), normalizeText('UT Martin')],
  [normalizeText('SIU Edwardsville')]: [normalizeText('SIUE'), normalizeText('Southern Illinois Univ Edwardsville')],
  [normalizeText('Jackson State')]: [normalizeText('Jackson St.')],
  [normalizeText('North Alabama')]: [normalizeText('North Ala.')],
  [normalizeText('Western Michigan')]: [normalizeText('Western Mich.')],
  [normalizeText('Florida Gulf Coast')]: [normalizeText('FGCU')],
  [normalizeText('Missouri State')]: [normalizeText('Missouri St.')],
  [normalizeText('Texas State')]: [normalizeText('Texas St.')],
  [normalizeText("St. John's")]: [normalizeText("St. John's (NY)"), normalizeText("Saint John's")],
  [normalizeText('California Baptist')]: [normalizeText('Cal Baptist')],
  [normalizeText('East Tennessee State')]: [normalizeText('East Tenn. St.')],
  [normalizeText('Ole Miss')]: [normalizeText('Mississippi')],
  [normalizeText('UTSA')]: [normalizeText('Texas at San Antonio')],
  [normalizeText('Tarleton')]: [normalizeText('Tarleton St.')],
  [normalizeText('Northern Kentucky')]: [normalizeText('Northern Ky.')],
  [normalizeText('Western Kentucky')]: [normalizeText('Western Ky.')],
  [normalizeText('UT Rio Grande Valley')]: [normalizeText('Texas Rio Grande Valley'), normalizeText('UTRGV')],
  [normalizeText('NC State')]: [normalizeText('North Carolina St.')],
  [normalizeText('USC Upstate')]: [normalizeText('South Carolina Upstate')],
  [normalizeText('McNeese')]: [normalizeText('McNeese St.')],
  [normalizeText('Southeastern Louisiana')]: [normalizeText('Southeastern La.')],
  [normalizeText('Louisiana')]: [normalizeText('La. Lafayette'), normalizeText('Louisiana Lafayette')],
  [normalizeText('Central Michigan')]: [normalizeText('Central Mich.')],
  [normalizeText('Eastern Kentucky')]: [normalizeText('Eastern Ky.')],
}

await main()
