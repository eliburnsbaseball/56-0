import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import './App.css'

type DraftMode = 'classic' | 'hard'
type Slot = 'C' | '1B' | '2B' | '3B' | 'SS' | 'LF' | 'CF' | 'RF' | 'SP' | 'RP'
type Era = 'pre-2000s' | '2000s' | '2010s' | '2020s'
type PositionFilter = 'ALL' | Slot
type SortKey = 'rating' | 'games' | 'avg' | 'ops' | 'hr' | 'rbi' | 'era' | 'whip' | 'so'
type AssignmentKind = 'power5' | 'midMajor'
type ModeId = 'classic' | 'hard' | 'classic-2020s' | 'hard-2020s'

type Player = {
  id: string
  season: number
  seasonStart: number
  seasonEnd: number
  seasonCount: number
  era: Era
  category: 'hitter' | 'pitcher'
  name: string
  team: string
  classYear: string
  primaryPosition: Slot
  eligiblePositions: Slot[]
  teamTier: AssignmentKind
  conference: string
  value: number
  logoSlug: string | null
  stats: {
    games?: number
    avg?: number
    ops?: number
    hr?: number
    rbi?: number
    sb?: number
    wins?: number
    era?: number
    whip?: number
    strikeouts?: number
    innings?: number
    saves?: number
    starts?: number
  }
  statLine: string
  source: string
}

type Meta = {
  generatedAt: string
  rosterSlots: Slot[]
  availableEras: Era[]
  positionFilters: PositionFilter[]
  sortOptions: SortKey[]
  playerChunks?: string[]
  modelDiagnostics: {
    historicalPlayers: number
  }
}

type DraftAssignment = {
  era: Era
  kind: AssignmentKind
  label: string
  team?: string
  conference?: string
}

type SlotInstance = {
  key: string
  slot: Slot
  label: string
}

type DraftedMap = Record<string, Player>
type DraftedEntry = SlotInstance & { player: Player | null }
type DraftRound = {
  assignment: DraftAssignment
  candidates: Player[]
}

type LeaderboardEntry = {
  id: string
  name: string
  wins: number
  losses: number
  war: number
  createdAt: string
}

type Leaderboards = Record<ModeId, LeaderboardEntry[]>
type OptimalSummary = {
  totalPoints: number
  wins: number
  losses: number
  draftedList: DraftedEntry[]
}
type UniversalBestMap = Partial<Record<ModeId, OptimalSummary | null>>
type SimulationSummary = {
  sampleSize: number
  totals: number[]
  percentilePoints: {
    p50: number
    p90: number
    p99: number
  }
  bestRun: {
    totalPoints: number
    wins: number
    losses: number
  }
}
type AssignmentPoolResult = {
  players: Player[]
  usedFallback: boolean
  fallbackLabel: string | null
}

type ModeConfig = {
  label: string
  draftMode: DraftMode
  eraFilter: Era | null
  description: string
  leaderboardLabel: string
  availability: string
  orderLabel: string
}

type ShareState = 'idle' | 'shared' | 'copied' | 'downloaded' | 'unsupported'

const DEFAULT_ROSTER: Slot[] = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'SP', 'SP', 'SP', 'RP', 'RP']
const DEFAULT_ERAS: Era[] = ['pre-2000s', '2000s', '2010s', '2020s']
const POSITION_FILTERS: PositionFilter[] = ['ALL', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'SP', 'RP']
const SORT_OPTIONS: SortKey[] = ['rating', 'games', 'avg', 'ops', 'hr', 'rbi', 'era', 'whip', 'so']
const LEADERBOARD_STORAGE_KEY = 'college-baseball-diamond-leaderboards-v1'
const TEAM_POOL_MINIMUM = 18
const RULES = [
  ['13 slots', 'C, 1B, 2B, 3B, SS, LF, CF, RF, SP1, SP2, SP3, RP1, RP2.'],
  ['Random boards', 'Each pick spins to a new school or conference board, and you can re-spin team or era before you lock in the next pick.'],
  ['Career value', 'Ratings use full college careers, so four good years beat one short spike.'],
  ['56-game finish', 'Projected records use a tougher 56-game curve so unbeaten runs stay rare.'],
] as const

const scoreFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const MODE_CONFIG: Record<ModeId, ModeConfig> = {
  classic: {
    label: 'Classic',
    draftMode: 'classic',
    eraFilter: null,
    description: 'All eras on a ranked board built from full career value.',
    leaderboardLabel: 'Classic',
    availability: 'All eras',
    orderLabel: 'Ranked board',
  },
  hard: {
    label: 'Hard',
    draftMode: 'hard',
    eraFilter: null,
    description: 'All eras, with the board locked to alphabetical order.',
    leaderboardLabel: 'Hard',
    availability: 'All eras',
    orderLabel: 'Alphabetical board',
  },
  'classic-2020s': {
    label: '2020s Classic',
    draftMode: 'classic',
    eraFilter: '2020s',
    description: '2020s pool only on a ranked board built from full career value.',
    leaderboardLabel: '2020s Classic',
    availability: '2020s only',
    orderLabel: 'Ranked board',
  },
  'hard-2020s': {
    label: '2020s Hard',
    draftMode: 'hard',
    eraFilter: '2020s',
    description: '2020s pool only, with the board locked to alphabetical order.',
    leaderboardLabel: '2020s Hard',
    availability: '2020s only',
    orderLabel: 'Alphabetical board',
  },
}

function choice<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)]
}

function buildSlotInstances(rosterSlots: Slot[]): SlotInstance[] {
  const counts = new Map<Slot, number>()
  return rosterSlots.map((slot) => {
    const next = (counts.get(slot) ?? 0) + 1
    counts.set(slot, next)
    return {
      key: `${slot}-${next}`,
      slot,
      label: slot === 'SP' || slot === 'RP' ? `${slot}${next}` : slot,
    }
  })
}

function matchesAssignment(player: Player, assignment: DraftAssignment) {
  if (player.era !== assignment.era) return false
  if (assignment.kind === 'power5') return player.team === assignment.team
  return player.conference === assignment.conference
}

function playerMatchesMode(player: Player, modeId: ModeId | null) {
  if (!modeId) return true
  const config = MODE_CONFIG[modeId]
  if (!config.eraFilter) return true
  return player.era === config.eraFilter
}

function getOpenSlotInstances(slotInstances: SlotInstance[], drafted: DraftedMap) {
  return slotInstances.filter((entry) => !drafted[entry.key])
}

function getOpenPositionsForPlayer(player: Player, slotInstances: SlotInstance[], drafted: DraftedMap) {
  const openSlots = getOpenSlotInstances(slotInstances, drafted)
  return player.eligiblePositions.filter((position) => openSlots.some((entry) => entry.slot === position))
}

function getSlotKeyForPosition(position: Slot, slotInstances: SlotInstance[], drafted: DraftedMap) {
  return slotInstances.find((entry) => entry.slot === position && !drafted[entry.key])?.key ?? null
}

function getSortValue(player: Player, sortKey: SortKey) {
  switch (sortKey) {
    case 'games':
      return player.stats.games ?? -1
    case 'avg':
      return player.stats.avg ?? -1
    case 'ops':
      return player.stats.ops ?? -1
    case 'hr':
      return player.stats.hr ?? -1
    case 'rbi':
      return player.stats.rbi ?? -1
    case 'era':
      return player.stats.era ?? Number.POSITIVE_INFINITY
    case 'whip':
      return player.stats.whip ?? Number.POSITIVE_INFINITY
    case 'so':
      return player.stats.strikeouts ?? -1
    case 'rating':
    default:
      return player.value
  }
}

function formatRate(value?: number) {
  if (value === undefined || value === null) return '-'
  return value.toFixed(3)
}

function formatSeasonLabel(player: Player) {
  if (player.seasonStart === player.seasonEnd) return `${player.seasonEnd}`
  return `${player.seasonStart}-${player.seasonEnd}`
}

function formatCareerLabel(player: Player) {
  const seasonWord = player.seasonCount === 1 ? 'season' : 'seasons'
  return `${formatSeasonLabel(player)} - ${player.seasonCount} ${seasonWord}`
}

function formatPlayerType(player: Player) {
  return player.category === 'pitcher' ? 'Pitcher' : 'Hitter'
}

function formatPlayerStatSummary(player: Player) {
  if (player.category === 'pitcher') {
    return `ERA ${player.stats.era?.toFixed(2) ?? '-'} | WHIP ${player.stats.whip?.toFixed(3) ?? '-'} | SO ${player.stats.strikeouts ?? 0} | IP ${player.stats.innings?.toFixed(1) ?? '0.0'}`
  }

  return `AVG ${formatRate(player.stats.avg)} | OPS ${formatRate(player.stats.ops)} | RBI ${player.stats.rbi ?? 0} | SB ${player.stats.sb ?? 0}`
}

function formatCompactPlayerStatSummary(player: Player) {
  if (player.category === 'pitcher') {
    return `${player.stats.era?.toFixed(2) ?? '-'} ERA - ${player.stats.whip?.toFixed(3) ?? '-'} WHIP - ${player.stats.strikeouts ?? 0} SO`
  }

  return `${formatRate(player.stats.avg)} AVG - ${player.stats.hr ?? 0} HR - ${formatRate(player.stats.ops)} OPS`
}

function formatPositionBadge(positions: Slot[]) {
  return positions.join('/')
}

function getPlayerVolume(player: Player) {
  if (player.category === 'pitcher') {
    return player.stats.innings ?? player.stats.games ?? 0
  }

  return player.stats.games ?? 0
}

function getDisplayedEligiblePositions(player: Player, slotInstances: SlotInstance[], drafted: DraftedMap) {
  const openPositions = getOpenPositionsForPlayer(player, slotInstances, drafted)
  return openPositions.length > 0 ? openPositions : player.eligiblePositions
}

function inverseNormalCdf(probability: number) {
  const p = Math.min(1 - 1e-9, Math.max(1e-9, probability))
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924]
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857]
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878]
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]
  const low = 0.02425
  const high = 1 - low

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

function estimateWinsFromPercentile(percentile: number) {
  if (percentile >= 99) return 56
  const probability = Math.min(0.99, Math.max(0.01, percentile / 100))
  const zScore = inverseNormalCdf(probability)
  const projected = 28 + zScore * 8.25
  return Math.max(10, Math.min(55, Math.round(projected)))
}

function estimateLossesFromPercentile(percentile: number) {
  return Math.max(0, 56 - estimateWinsFromPercentile(percentile))
}

function getAssignmentKey(assignment: DraftAssignment) {
  return `${assignment.era}|${assignment.kind}|${assignment.team ?? assignment.conference ?? assignment.label}`
}

function buildAssignmentForPlayer(player: Player): DraftAssignment {
  return player.teamTier === 'power5'
    ? { era: player.era, kind: 'power5', label: player.team, team: player.team }
    : { era: player.era, kind: 'midMajor', label: player.conference, conference: player.conference }
}

function buildAssignments(players: Player[], drafted: DraftedMap, slotInstances: SlotInstance[], modeId: ModeId | null) {
  const draftedIds = new Set(Object.values(drafted).map((player) => player.id))
  const assignments: DraftAssignment[] = []
  const seen = new Set<string>()

  for (const player of players) {
    if (!playerMatchesMode(player, modeId)) continue
    if (draftedIds.has(player.id)) continue
    if (getOpenPositionsForPlayer(player, slotInstances, drafted).length === 0) continue

    const assignment = buildAssignmentForPlayer(player)
    const key = getAssignmentKey(assignment)
    if (!seen.has(key)) {
      seen.add(key)
      assignments.push(assignment)
    }
  }

  return assignments
}

function buildAssignmentPools(players: Player[], modeId: ModeId | null) {
  const pools = new Map<string, { assignment: DraftAssignment; players: Player[] }>()

  for (const player of players) {
    if (!playerMatchesMode(player, modeId)) continue
    const assignment = buildAssignmentForPlayer(player)
    const key = getAssignmentKey(assignment)
    const current = pools.get(key)
    if (current) {
      current.players.push(player)
      continue
    }
    pools.set(key, { assignment, players: [player] })
  }

  for (const pool of pools.values()) {
    pool.players.sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
  }

  return [...pools.values()]
}

function getAssignmentPoolResult(
  players: Player[],
  assignment: DraftAssignment | null,
  modeId: ModeId | null,
  drafted: DraftedMap,
  slotInstances: SlotInstance[],
  spinning: boolean,
): AssignmentPoolResult {
  if (!assignment || spinning) {
    return { players: [], usedFallback: false, fallbackLabel: null }
  }

  const draftedIds = new Set(Object.values(drafted).map((player) => player.id))
  const basePlayers = players
    .filter((player) => playerMatchesMode(player, modeId))
    .filter((player) => !draftedIds.has(player.id))
    .filter((player) => matchesAssignment(player, assignment))
    .filter((player) => getOpenPositionsForPlayer(player, slotInstances, drafted).length > 0)

  if (assignment.kind !== 'power5' || basePlayers.length >= TEAM_POOL_MINIMUM) {
    return { players: basePlayers, usedFallback: false, fallbackLabel: null }
  }

  const teamSeed = players.find((player) => playerMatchesMode(player, modeId) && player.team === assignment.team)
  const conference = teamSeed?.conference
  if (!conference) {
    return { players: basePlayers, usedFallback: false, fallbackLabel: null }
  }

  const fallbackPlayers = players
    .filter((player) => playerMatchesMode(player, modeId))
    .filter((player) => !draftedIds.has(player.id))
    .filter((player) => player.era === assignment.era)
    .filter((player) => player.conference === conference)
    .filter((player) => getOpenPositionsForPlayer(player, slotInstances, drafted).length > 0)

  if (fallbackPlayers.length <= basePlayers.length) {
    return { players: basePlayers, usedFallback: false, fallbackLabel: null }
  }

  return {
    players: fallbackPlayers,
    usedFallback: true,
    fallbackLabel: `${conference} depth pool`,
  }
}

function percentileFromSortedTotals(sortedTotals: number[], value: number) {
  if (sortedTotals.length === 0) return 50
  let low = 0
  let high = sortedTotals.length

  while (low < high) {
    const middle = (low + high) >> 1
    if (sortedTotals[middle] <= value) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  return Math.max(1, Math.min(99, Math.round((low / sortedTotals.length) * 100)))
}

function quantileFromSortedTotals(sortedTotals: number[], percentile: number) {
  if (sortedTotals.length === 0) return 0
  const index = Math.max(0, Math.min(sortedTotals.length - 1, Math.round((sortedTotals.length - 1) * percentile)))
  return sortedTotals[index]
}

function chooseBestPositionForPlayer(player: Player, slotInstances: SlotInstance[], drafted: DraftedMap, slotSupply: Map<Slot, number>) {
  const openPositions = getOpenPositionsForPlayer(player, slotInstances, drafted)
  if (openPositions.length === 0) return null

  return [...openPositions].sort((left, right) => {
    const supplyDelta = (slotSupply.get(left) ?? 0) - (slotSupply.get(right) ?? 0)
    if (supplyDelta !== 0) return supplyDelta
    const leftIndex = slotInstances.findIndex((entry) => entry.slot === left && !drafted[entry.key])
    const rightIndex = slotInstances.findIndex((entry) => entry.slot === right && !drafted[entry.key])
    return leftIndex - rightIndex
  })[0]
}

function findBestAvailablePlayer(poolPlayers: Player[], slotInstances: SlotInstance[], drafted: DraftedMap, draftedIds: Set<string>) {
  for (const player of poolPlayers) {
    if (draftedIds.has(player.id)) continue
    if (getOpenPositionsForPlayer(player, slotInstances, drafted).length > 0) return player
  }
  return null
}

function buildSimulationSummary(players: Player[], slotInstances: SlotInstance[], modeId: ModeId | null, sampleSize = 1000): SimulationSummary | null {
  if (!modeId || players.length === 0) return null

  const assignmentPools = buildAssignmentPools(players, modeId)
  if (assignmentPools.length === 0) return null

  const slotSupply = slotInstances.reduce((map, entry) => {
    const count = players.filter((player) => playerMatchesMode(player, modeId) && player.eligiblePositions.includes(entry.slot)).length
    map.set(entry.slot, count)
    return map
  }, new Map<Slot, number>())

  const totals: number[] = []

  for (let runIndex = 0; runIndex < sampleSize; runIndex += 1) {
    const drafted: DraftedMap = {}
    const draftedIds = new Set<string>()
    let previousAssignment: DraftAssignment | null = null

    for (let pickIndex = 0; pickIndex < slotInstances.length; pickIndex += 1) {
      const availableAssignments = assignmentPools
        .filter(({ players: poolPlayers }) => findBestAvailablePlayer(poolPlayers, slotInstances, drafted, draftedIds))
        .map(({ assignment }) => assignment)

      if (availableAssignments.length === 0) break

      const assignment = selectRandomAssignment(availableAssignments, previousAssignment)
      if (!assignment) break

      const pool = assignmentPools.find((entry) => getAssignmentKey(entry.assignment) === getAssignmentKey(assignment))
      if (!pool) break

      const player = findBestAvailablePlayer(pool.players, slotInstances, drafted, draftedIds)
      if (!player) break

      const position = chooseBestPositionForPlayer(player, slotInstances, drafted, slotSupply)
      if (!position) break

      const slotKey = getSlotKeyForPosition(position, slotInstances, drafted)
      if (!slotKey) break

      drafted[slotKey] = player
      draftedIds.add(player.id)
      previousAssignment = assignment
    }

    totals.push(Object.values(drafted).reduce((sum, player) => sum + player.value, 0))
  }

  const sortedTotals = [...totals].sort((left, right) => left - right)
  const bestTotal = sortedTotals[sortedTotals.length - 1] ?? 0
  const bestPercentile = percentileFromSortedTotals(sortedTotals, bestTotal)

  return {
    sampleSize,
    totals: sortedTotals,
    percentilePoints: {
      p50: quantileFromSortedTotals(sortedTotals, 0.5),
      p90: quantileFromSortedTotals(sortedTotals, 0.9),
      p99: quantileFromSortedTotals(sortedTotals, 0.99),
    },
    bestRun: {
      totalPoints: bestTotal,
      wins: estimateWinsFromPercentile(bestPercentile),
      losses: estimateLossesFromPercentile(bestPercentile),
    },
  }
}

function selectRandomAssignment(assignments: DraftAssignment[], previous: DraftAssignment | null) {
  if (assignments.length === 0) return null
  if (!previous) return choice(assignments)

  const filtered = assignments.filter(
    (assignment) =>
      assignment.era !== previous.era ||
      assignment.kind !== previous.kind ||
      assignment.team !== previous.team ||
      assignment.conference !== previous.conference,
  )

  return choice(filtered.length > 0 ? filtered : assignments)
}

function selectTeamRespinAssignment(assignments: DraftAssignment[], current: DraftAssignment | null) {
  if (!current) return selectRandomAssignment(assignments, null)
  const sameEra = assignments.filter(
    (assignment) =>
      assignment.era === current.era &&
      (assignment.kind !== current.kind ||
        assignment.team !== current.team ||
        assignment.conference !== current.conference),
  )

  return choice(sameEra.length > 0 ? sameEra : assignments)
}

function selectEraRespinAssignment(assignments: DraftAssignment[], current: DraftAssignment | null) {
  if (!current) return selectRandomAssignment(assignments, null)

  const differentEraSameLabel = assignments.filter((assignment) => {
    if (assignment.era === current.era || assignment.kind !== current.kind) return false
    if (assignment.kind === 'power5') return assignment.team === current.team
    return assignment.conference === current.conference
  })

  if (differentEraSameLabel.length > 0) return choice(differentEraSameLabel)

  const differentEra = assignments.filter((assignment) => assignment.era !== current.era)
  return choice(differentEra.length > 0 ? differentEra : assignments)
}

function createEmptyLeaderboards(): Leaderboards {
  return {
    classic: [],
    hard: [],
    'classic-2020s': [],
    'hard-2020s': [],
  }
}

function readLeaderboards(): Leaderboards {
  try {
    const raw = window.localStorage.getItem(LEADERBOARD_STORAGE_KEY)
    if (!raw) return createEmptyLeaderboards()
    const parsed = JSON.parse(raw) as Partial<Leaderboards>
    return {
      classic: parsed.classic ?? [],
      hard: parsed.hard ?? [],
      'classic-2020s': parsed['classic-2020s'] ?? [],
      'hard-2020s': parsed['hard-2020s'] ?? [],
    }
  } catch {
    return createEmptyLeaderboards()
  }
}

function writeLeaderboards(next: Leaderboards) {
  window.localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(next))
}

function sortLeaderboard(entries: LeaderboardEntry[]) {
  return [...entries]
    .sort((left, right) => right.wins - left.wins || right.war - left.war || left.createdAt.localeCompare(right.createdAt))
    .slice(0, 10)
}

function hasAnyLeaderboardEntries(leaderboards: Leaderboards) {
  return Object.values(leaderboards).some((entries) => entries.length > 0)
}

function buildRunOptimalSummary(rounds: DraftRound[], slotInstances: SlotInstance[], simulationSummary: SimulationSummary | null): OptimalSummary | null {
  if (rounds.length === 0 || slotInstances.length === 0 || slotInstances.length > 20) return null

  const fullMask = (1 << slotInstances.length) - 1
  const scores = new Float64Array(fullMask + 1)
  scores.fill(Number.NEGATIVE_INFINITY)
  scores[0] = 0

  const previousMask = new Int32Array(fullMask + 1)
  const previousCandidateIndex = new Int32Array(fullMask + 1)
  const previousRoundIndex = new Int32Array(fullMask + 1)
  const previousSlotIndex = new Int32Array(fullMask + 1)
  previousMask.fill(-1)
  previousCandidateIndex.fill(-1)
  previousRoundIndex.fill(-1)
  previousSlotIndex.fill(-1)

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const round = rounds[roundIndex]
    const nextScores = new Float64Array(fullMask + 1)
    nextScores.set(scores)
    const nextPreviousMask = new Int32Array(previousMask)
    const nextPreviousCandidateIndex = new Int32Array(previousCandidateIndex)
    const nextPreviousRoundIndex = new Int32Array(previousRoundIndex)
    const nextPreviousSlotIndex = new Int32Array(previousSlotIndex)

    for (let mask = 0; mask <= fullMask; mask += 1) {
      const currentScore = scores[mask]
      if (!Number.isFinite(currentScore)) continue

      for (let candidateIndex = 0; candidateIndex < round.candidates.length; candidateIndex += 1) {
        const player = round.candidates[candidateIndex]
        let openMask = slotInstances.reduce(
          (candidateMask, entry, slotIndex) => (player.eligiblePositions.includes(entry.slot) && (mask & (1 << slotIndex)) === 0 ? candidateMask | (1 << slotIndex) : candidateMask),
          0,
        )

        while (openMask > 0) {
          const slotBit = openMask & -openMask
          const nextMask = mask | slotBit
          const nextScore = currentScore + player.value
          if (nextScore > nextScores[nextMask]) {
            nextScores[nextMask] = nextScore
            nextPreviousMask[nextMask] = mask
            nextPreviousCandidateIndex[nextMask] = candidateIndex
            nextPreviousRoundIndex[nextMask] = roundIndex
            nextPreviousSlotIndex[nextMask] = Math.log2(slotBit) | 0
          }
          openMask -= slotBit
        }
      }
    }

    scores.set(nextScores)
    previousMask.set(nextPreviousMask)
    previousCandidateIndex.set(nextPreviousCandidateIndex)
    previousRoundIndex.set(nextPreviousRoundIndex)
    previousSlotIndex.set(nextPreviousSlotIndex)
  }

  if (!Number.isFinite(scores[fullMask])) return null

  const draftedList: DraftedEntry[] = []
  let mask = fullMask
  while (mask > 0) {
    const roundIndex = previousRoundIndex[mask]
    const candidateIndex = previousCandidateIndex[mask]
    const slotIndex = previousSlotIndex[mask]
    const priorMask = previousMask[mask]
    if (roundIndex < 0 || candidateIndex < 0 || slotIndex < 0 || priorMask < 0) break

    draftedList.push({
      ...slotInstances[slotIndex],
      player: rounds[roundIndex].candidates[candidateIndex],
    })
    mask = priorMask
  }

  draftedList.sort((left, right) => slotInstances.findIndex((entry) => entry.key === left.key) - slotInstances.findIndex((entry) => entry.key === right.key))
  const totalPoints = draftedList.reduce((sum, entry) => sum + (entry.player?.value ?? 0), 0)
  const percentile = percentileFromSortedTotals(simulationSummary?.totals ?? [], totalPoints)

  return {
    totalPoints,
    wins: estimateWinsFromPercentile(percentile),
    losses: estimateLossesFromPercentile(percentile),
    draftedList,
  }
}

function buildUniversalOptimalSummary(
  players: Player[],
  slotInstances: SlotInstance[],
  modeId: ModeId | null,
  simulationSummary: SimulationSummary | null,
): OptimalSummary | null {
  if (!modeId || players.length === 0 || slotInstances.length === 0 || slotInstances.length > 20) return null

  const modePlayers = players.filter((player) => playerMatchesMode(player, modeId))
  const candidateMap = new Map<string, Player>()

  for (const entry of slotInstances) {
    modePlayers
      .filter((player) => player.eligiblePositions.includes(entry.slot))
      .sort((left, right) => right.value - left.value || getPlayerVolume(right) - getPlayerVolume(left))
      .slice(0, 140)
      .forEach((player) => candidateMap.set(player.id, player))
  }

  const candidates = [...candidateMap.values()]
  const fullMask = (1 << slotInstances.length) - 1
  const scores = new Float64Array(fullMask + 1)
  scores.fill(Number.NEGATIVE_INFINITY)
  scores[0] = 0

  const previousMask = new Int32Array(fullMask + 1)
  const previousPlayerIndex = new Int32Array(fullMask + 1)
  const previousSlotIndex = new Int32Array(fullMask + 1)
  previousMask.fill(-1)
  previousPlayerIndex.fill(-1)
  previousSlotIndex.fill(-1)

  const eligibleMasks = candidates.map((player) =>
    slotInstances.reduce((mask, entry, index) => (player.eligiblePositions.includes(entry.slot) ? mask | (1 << index) : mask), 0),
  )

  for (let playerIndex = 0; playerIndex < candidates.length; playerIndex += 1) {
    const eligibleMask = eligibleMasks[playerIndex]
    if (eligibleMask === 0) continue

    for (let mask = fullMask; mask >= 0; mask -= 1) {
      const currentScore = scores[mask]
      if (!Number.isFinite(currentScore)) continue

      let openMask = eligibleMask & ~mask
      while (openMask > 0) {
        const slotBit = openMask & -openMask
        const nextMask = mask | slotBit
        const nextScore = currentScore + candidates[playerIndex].value
        if (nextScore > scores[nextMask]) {
          scores[nextMask] = nextScore
          previousMask[nextMask] = mask
          previousPlayerIndex[nextMask] = playerIndex
          previousSlotIndex[nextMask] = Math.log2(slotBit) | 0
        }
        openMask -= slotBit
      }
    }
  }

  if (!Number.isFinite(scores[fullMask])) return null

  const draftedList: DraftedEntry[] = []
  let mask = fullMask
  while (mask > 0) {
    const playerIndex = previousPlayerIndex[mask]
    const slotIndex = previousSlotIndex[mask]
    const priorMask = previousMask[mask]
    if (playerIndex < 0 || slotIndex < 0 || priorMask < 0) break

    draftedList.push({
      ...slotInstances[slotIndex],
      player: candidates[playerIndex],
    })
    mask = priorMask
  }

  draftedList.sort((left, right) => slotInstances.findIndex((entry) => entry.key === left.key) - slotInstances.findIndex((entry) => entry.key === right.key))
  const totalPoints = draftedList.reduce((sum, entry) => sum + (entry.player?.value ?? 0), 0)
  const percentile = percentileFromSortedTotals(simulationSummary?.totals ?? [], totalPoints)

  return {
    totalPoints,
    wins: estimateWinsFromPercentile(percentile),
    losses: estimateLossesFromPercentile(percentile),
    draftedList,
  }
}

function formatModeSummary(mode: ModeConfig, era: Era) {
  return `${mode.label} | ${era} | ${mode.orderLabel.toLowerCase()}`
}

function formatPoints(value: number) {
  return `${scoreFormatter.format(value)} points`
}

function cloneNodeWithInlineStyles(source: HTMLElement) {
  const clone = source.cloneNode(true) as HTMLElement
  const sourceNodes = [source, ...Array.from(source.querySelectorAll<HTMLElement>('*'))]
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))]

  sourceNodes.forEach((sourceNode, index) => {
    const targetNode = cloneNodes[index]
    const computed = window.getComputedStyle(sourceNode)
    const cssText = Array.from(computed).map((property) => `${property}:${computed.getPropertyValue(property)};`).join('')
    targetNode.setAttribute('style', cssText)
  })

  return clone
}

async function renderElementToPng(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const width = Math.max(Math.ceil(rect.width), 1)
  const height = Math.max(Math.ceil(rect.height), 1)
  const cloned = cloneNodeWithInlineStyles(element)
  cloned.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')

  const serialized = new XMLSerializer().serializeToString(cloned)
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <foreignObject width="100%" height="100%">${serialized}</foreignObject>
    </svg>
  `

  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image()
      nextImage.onload = () => resolve(nextImage)
      nextImage.onerror = () => reject(new Error('Unable to render share image.'))
      nextImage.src = svgUrl
    })

    const canvas = document.createElement('canvas')
    const scale = Math.max(window.devicePixelRatio, 2)
    canvas.width = width * scale
    canvas.height = height * scale
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Unable to create share image context.')
    }

    context.scale(scale, scale)
    context.drawImage(image, 0, 0, width, height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Unable to export share image.'))
          return
        }
        resolve(blob)
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

function classifyRosterStrength(totalWar: number) {
  if (totalWar >= 180) return 'Dynasty-level roster'
  if (totalWar >= 145) return 'Elite lineup with real depth'
  if (totalWar >= 110) return 'Balanced contender'
  if (totalWar >= 80) return 'Competitive but beatable'
  return 'Underdog build'
}

function summarizeRoster(draftedList: DraftedEntry[], totalWar: number, wins: number, losses: number) {
  const draftedPlayers = draftedList
    .map((entry) => entry.player)
    .filter((player): player is Player => Boolean(player))

  const byValueDesc = [...draftedPlayers].sort((left, right) => right.value - left.value)
  const hitters = byValueDesc.filter((player) => player.category === 'hitter')
  const pitchers = byValueDesc.filter((player) => player.category === 'pitcher')
  const weakestEntry = [...draftedList]
    .filter((entry): entry is DraftedEntry & { player: Player } => Boolean(entry.player))
    .sort((left, right) => left.player.value - right.player.value)[0]

  return {
    bestPlayer: byValueDesc[0] ?? null,
    bestHitter: hitters[0] ?? null,
    bestPitcher: pitchers[0] ?? null,
    weakestEntry: weakestEntry ?? null,
    averageWar: draftedPlayers.length > 0 ? totalWar / draftedPlayers.length : 0,
    strengthLabel: classifyRosterStrength(totalWar),
    recordLabel: `${wins}-${losses}`,
  }
}

function AppShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={`app-frame${wide ? ' wide' : ''}`}>{children}</main>
}

function LoadingScreen() {
  return (
    <AppShell>
      <section className="loading-view">
        <div className="loading-mark">College Baseball Diamond Draft</div>
        <h1>Loading the player pool</h1>
        <p>Pulling together schools, conferences, eras, and career value for the full draft board.</p>
      </section>
    </AppShell>
  )
}

function ModeSelector({
  onStart,
  universalBests,
}: {
  onStart: (modeId: ModeId) => void
  universalBests: UniversalBestMap
}) {
  return (
    <div className="mode-list">
      {(Object.entries(MODE_CONFIG) as [ModeId, ModeConfig][]).map(([modeId, config]) => (
        <article key={modeId} className="mode-row">
          <div className="mode-row-main">
            <div className="mode-row-titleline">
              <h3>{config.label}</h3>
              <div className="mode-tags">
                <span>{config.availability}</span>
                <span>{config.orderLabel}</span>
              </div>
            </div>
            <p>{config.description}</p>
            {universalBests[modeId] ? (
              <p className="mode-best">
                All-time best: {universalBests[modeId]!.wins}-{universalBests[modeId]!.losses} - {formatPoints(universalBests[modeId]!.totalPoints)}
              </p>
            ) : null}
          </div>

          <div className="mode-row-actions">
            <span className="mode-status">Ready</span>
            <button type="button" className="button button-primary" onClick={() => onStart(modeId)}>
              Start Draft
            </button>
          </div>
        </article>
      ))}
    </div>
  )
}

function LeaderboardTable({
  title,
  entries,
}: {
  title: string
  entries: LeaderboardEntry[]
}) {
  return (
    <section className="leaderboard-table-wrap">
      <div className="section-bar">
        <h3>{title}</h3>
        <span>Top {entries.length}</span>
      </div>

      <div className="leaderboard-table">
        <div className="leaderboard-row leaderboard-head">
          <span>RK</span>
          <span>Saved Run</span>
          <span>Record</span>
          <span>PTS</span>
        </div>

        {entries.map((entry, index) => (
          <div key={entry.id} className="leaderboard-row">
            <span data-label="RK">{index + 1}</span>
            <strong data-label="Saved Run">{entry.name}</strong>
            <span data-label="Record">{entry.wins}-{entry.losses}</span>
            <b data-label="Points">{scoreFormatter.format(entry.war)}</b>
          </div>
        ))}
      </div>
    </section>
  )
}

function LandingPage({
  leaderboards,
  onStart,
  universalBests,
}: {
  leaderboards: Leaderboards
  onStart: (modeId: ModeId) => void
  universalBests: UniversalBestMap
}) {
  const hasSavedRuns = hasAnyLeaderboardEntries(leaderboards)
  const populatedLeaderboards = (Object.entries(MODE_CONFIG) as [ModeId, ModeConfig][])
    .filter(([modeId]) => leaderboards[modeId].length > 0)

  return (
    <AppShell>
      <section className="landing-page">
        <header className="landing-header">
          <div className="landing-copy">
            <p className="section-kicker">College Baseball Diamond Draft</p>
            <h1>Build a 56-0 College Baseball Roster</h1>
            <p>
              Draft a full 13-man roster from rotating school and conference boards, then see whether the build holds up
              over a 56-game season.
            </p>
          </div>

          <div className="landing-cta-panel">
            <div>
              <span className="section-kicker">Quick Start</span>
              <strong>Classic board across every era</strong>
            </div>
            <button type="button" className="button button-primary button-large" onClick={() => onStart('classic')}>
              Start Classic Draft
            </button>
          </div>
        </header>

        <section className="landing-section">
          <div className="section-bar">
            <div>
              <p className="section-kicker">Choose Draft Mode</p>
              <h2>Pick your board</h2>
            </div>
            <span>Four ways to build a roster</span>
          </div>
          <ModeSelector onStart={onStart} universalBests={universalBests} />
        </section>

        <section className="landing-grid">
          <div className="landing-section">
            <div className="section-bar">
              <div>
                <p className="section-kicker">Your Best Runs</p>
                <h2>Standings</h2>
              </div>
              <span>{hasSavedRuns ? 'Saved by draft type' : 'No completed runs yet'}</span>
            </div>

            {!hasSavedRuns ? (
              <div className="empty-state">
                <strong>No completed runs yet.</strong>
                <p>Finish a draft, save the run, and the top 10 board will start filling in here.</p>
              </div>
            ) : (
              <div className="leaderboard-stack">
                {populatedLeaderboards.map(([modeId, config]) => (
                  <LeaderboardTable key={modeId} title={config.leaderboardLabel} entries={leaderboards[modeId]} />
                ))}
              </div>
            )}
          </div>

          <aside className="landing-section rules-panel">
            <div className="section-bar">
              <div>
                <p className="section-kicker">Roster Rules</p>
                <h2>Game Card</h2>
              </div>
            </div>

            <div className="rules-list">
              {RULES.map(([label, body]) => (
                <div key={label} className="rule-item">
                  <strong>{label}</strong>
                  <p>{body}</p>
                </div>
              ))}
            </div>
          </aside>
        </section>
      </section>
    </AppShell>
  )
}

function SpinnerWheel({
  spinning,
  era,
  label,
}: {
  spinning: boolean
  era: string
  label: string
}) {
  return (
    <div className={`spinner-wheel${spinning ? ' active' : ''}`}>
      <div className="spinner-lane">
        <span>Era</span>
        <strong>{era}</strong>
      </div>
      <div className="spinner-lane">
        <span>Draw</span>
        <strong>{label}</strong>
      </div>
    </div>
  )
}

function CurrentDrawPanel({
  spinning,
  assignment,
  currentEra,
  onSpinTeam,
  onSpinEra,
  disabled,
}: {
  spinning: boolean
  assignment: DraftAssignment | null
  currentEra: Era
  onSpinTeam: () => void
  onSpinEra: () => void
  disabled: boolean
}) {
  return (
    <section className="sidebar-section">
      <div className="section-bar compact">
        <div>
          <p className="section-kicker">War Room</p>
          <h3>{spinning ? 'Spinning board' : assignment?.label ?? 'Drawing board'}</h3>
        </div>
      </div>

      <div className="draw-hero">
        <strong>{assignment?.label ?? 'Waiting'}</strong>
        <span>{currentEra}</span>
      </div>

      <div className="draw-actions">
        <button type="button" className="button button-secondary" onClick={onSpinTeam} disabled={disabled}>
          Re-spin team
        </button>
        <button type="button" className="button button-secondary" onClick={onSpinEra} disabled={disabled}>
          Re-spin era
        </button>
      </div>

      <SpinnerWheel spinning={spinning} era={currentEra} label={assignment?.label ?? 'Waiting'} />
    </section>
  )
}

function FilterPanel({
  search,
  onSearchChange,
  selectedPosition,
  onSelectPosition,
  positionFilters,
  sortOptions,
  sortKey,
  onSelectSort,
  hardMode,
}: {
  search: string
  onSearchChange: (value: string) => void
  selectedPosition: PositionFilter
  onSelectPosition: (position: PositionFilter) => void
  positionFilters: PositionFilter[]
  sortOptions: SortKey[]
  sortKey: SortKey
  onSelectSort: (value: SortKey) => void
  hardMode: boolean
}) {
  return (
    <section className="sidebar-section">
      <div className="field-block">
        <label htmlFor="player-search" className="section-kicker">
          Search Board
        </label>
        <input
          id="player-search"
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Player, school, conference, or class"
        />
      </div>

      <div className="field-block">
        <div className="section-bar compact">
          <div>
            <p className="section-kicker">Positions</p>
          </div>
        </div>
        <div className="chip-row">
          {positionFilters.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`chip${selectedPosition === entry ? ' active' : ''}`}
              onClick={() => onSelectPosition(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      <div className="field-block">
        <div className="section-bar compact">
          <div>
            <p className="section-kicker">Board Order</p>
          </div>
          {hardMode ? <span>Locked</span> : null}
        </div>
        {hardMode ? (
          <div className="field-note">Hard mode keeps the board alphabetical for every draw.</div>
        ) : (
          <div className="segmented-control">
            {sortOptions.map((entry) => (
              <button
                key={entry}
                type="button"
                className={sortKey === entry ? 'active' : ''}
                onClick={() => onSelectSort(entry)}
              >
                {entry.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function RosterTracker({
  slotInstances,
  drafted,
  draftedCount,
}: {
  slotInstances: SlotInstance[]
  drafted: DraftedMap
  draftedCount: number
}) {
  return (
    <section className="sidebar-section">
      <div className="section-bar compact">
        <div>
          <p className="section-kicker">Roster Card</p>
          <h3>{draftedCount}/13 drafted</h3>
        </div>
      </div>

      <div className="roster-grid">
        {slotInstances.map((entry) => {
          const player = drafted[entry.key]
          return (
            <div key={entry.key} className={`roster-row${player ? ' filled' : ''}`}>
              <span className="roster-slot">{entry.label}</span>
              <div className="roster-player">
                <strong>{player?.name ?? 'Open'}</strong>
                <small>{player ? `${player.team} - ${formatSeasonLabel(player)}` : 'Waiting for pick'}</small>
                {player ? <small className="roster-player-stats">{formatPlayerStatSummary(player)}</small> : null}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function CandidateRow({
  index,
  player,
  slotInstances,
  drafted,
  canDraft,
  spinning,
  onDraft,
}: {
  index: number
  player: Player
  slotInstances: SlotInstance[]
  drafted: DraftedMap
  canDraft: boolean
  spinning: boolean
  onDraft: (player: Player) => void
}) {
  const displayedEligiblePositions = getDisplayedEligiblePositions(player, slotInstances, drafted)

  return (
    <div className={`candidate-row${canDraft ? '' : ' unavailable'}`}>
      <span className="candidate-mobile-badge" aria-hidden="true">
        {formatPositionBadge(displayedEligiblePositions)}
      </span>
      <span className="candidate-cell" data-label="Rank">
        {index + 1}
      </span>
      <strong className="candidate-cell candidate-name" data-label="Player">
        <span>{player.name}</span>
        <small className="candidate-mobile-meta">
          {player.team} - {formatSeasonLabel(player)}
        </small>
      </strong>
      <span className="candidate-cell" data-label="School">
        {player.team}
      </span>
      <span className="candidate-cell candidate-eligible" data-label="Eligible">
        {displayedEligiblePositions.join(' - ')}
      </span>
      <span className="candidate-cell" data-label="Type">
        {formatPlayerType(player)}
      </span>
      <span className="candidate-cell" data-label="Years">
        {formatCareerLabel(player)}
      </span>
      <span className="candidate-cell" data-label="G">
        {player.stats.games ?? 0}
      </span>
      <span className="candidate-cell candidate-statline" data-label="Key Stats">
        {formatPlayerStatSummary(player)}
        <small className="candidate-mobile-stats">{formatCompactPlayerStatSummary(player)}</small>
      </span>
      <div className="candidate-cell candidate-action" data-label="Action">
        <button type="button" className="button button-draft" disabled={!canDraft || spinning} onClick={() => onDraft(player)}>
          Draft
        </button>
      </div>
    </div>
  )
}

function CandidateTable({
  players,
  slotInstances,
  drafted,
  spinning,
  onDraft,
}: {
  players: Player[]
  slotInstances: SlotInstance[]
  drafted: DraftedMap
  spinning: boolean
  onDraft: (player: Player) => void
}) {
  return (
    <div className="candidate-table">
      <div className="candidate-table-head">
        <span>Rk</span>
        <span>Player</span>
        <span>School</span>
        <span>Eligible</span>
        <span>Type</span>
        <span>Years</span>
        <span>G</span>
        <span>Key Stats</span>
        <span>Action</span>
      </div>

      {players.map((player, index) => (
        <CandidateRow
          key={player.id}
          index={index}
          player={player}
          slotInstances={slotInstances}
          drafted={drafted}
          canDraft={getOpenPositionsForPlayer(player, slotInstances, drafted).length > 0}
          spinning={spinning}
          onDraft={onDraft}
        />
      ))}
    </div>
  )
}

function CandidateBoardPage({
  activeMode,
  assignment,
  currentEra,
  candidateLogoSlug,
  spinning,
  meta,
  filteredPlayers,
  usedFallback,
  fallbackLabel,
  drafted,
  draftedCount,
  selectedPosition,
  setSelectedPosition,
  sortKey,
  setSortKey,
  search,
  setSearch,
  slotInstances,
  onGoHome,
  onReset,
  onSpinTeam,
  onSpinEra,
  onDraft,
}: {
  activeMode: ModeConfig
  assignment: DraftAssignment | null
  currentEra: Era
  candidateLogoSlug: string | null
  spinning: boolean
  meta: Meta | null
  filteredPlayers: Player[]
  usedFallback: boolean
  fallbackLabel: string | null
  drafted: DraftedMap
  draftedCount: number
  selectedPosition: PositionFilter
  setSelectedPosition: (value: PositionFilter) => void
  sortKey: SortKey
  setSortKey: (value: SortKey) => void
  search: string
  setSearch: (value: string) => void
  slotInstances: SlotInstance[]
  onGoHome: () => void
  onReset: () => void
  onSpinTeam: () => void
  onSpinEra: () => void
  onDraft: (player: Player) => void
}) {
  return (
    <AppShell wide>
      <section className="board-page">
        <header className="board-header">
          <div className="board-header-copy">
            <p className="section-kicker">Candidate Board</p>
            <div className="board-header-titleline">
              <h1>{assignment?.label ?? 'Drawing board'}</h1>
              {candidateLogoSlug ? (
                <img className="header-logo" src={`https://ncaa-api.henrygd.me/logo/${candidateLogoSlug}.svg`} alt={`${assignment?.label} logo`} />
              ) : null}
            </div>
            <p className="board-header-meta">
              <span>{activeMode.label}</span>
              <span>{currentEra}</span>
              <span>{activeMode.orderLabel.toLowerCase()}</span>
            </p>
          </div>

          <div className="header-action-row">
            <button type="button" className="button button-secondary" onClick={onGoHome}>
              Home
            </button>
            <button type="button" className="button button-secondary" onClick={onReset}>
              Reset Draft
            </button>
          </div>
        </header>

        <section className="board-layout">
          <aside className="board-sidebar">
            <CurrentDrawPanel
              spinning={spinning}
              assignment={assignment}
              currentEra={currentEra}
              onSpinTeam={onSpinTeam}
              onSpinEra={onSpinEra}
              disabled={spinning}
            />

            <FilterPanel
              search={search}
              onSearchChange={setSearch}
              selectedPosition={selectedPosition}
              onSelectPosition={setSelectedPosition}
              positionFilters={meta?.positionFilters ?? POSITION_FILTERS}
              sortOptions={meta?.sortOptions ?? SORT_OPTIONS}
              sortKey={sortKey}
              onSelectSort={setSortKey}
              hardMode={activeMode.draftMode === 'hard'}
            />

            <RosterTracker
              slotInstances={slotInstances}
              drafted={drafted}
              draftedCount={draftedCount}
            />
          </aside>

          <section className="board-main">
            <div className="spin-banner">
              <p className="section-kicker">You Spun</p>
              <strong>{assignment?.label ?? 'Drawing board'}</strong>
              <span>{currentEra}</span>
            </div>

            <div className="status-strip">
              <span>{filteredPlayers.length} candidates shown</span>
              <span>{meta?.modelDiagnostics.historicalPlayers ?? 0} historical careers loaded</span>
              <span>Current roster: {draftedCount}/13 drafted</span>
              {usedFallback && fallbackLabel ? <span>{fallbackLabel}</span> : null}
            </div>

            {spinning ? <div className="board-loading">Cycling through eras and team draws...</div> : null}

            <CandidateTable players={filteredPlayers} slotInstances={slotInstances} drafted={drafted} spinning={spinning} onDraft={onDraft} />
          </section>
        </section>
      </section>
    </AppShell>
  )
}

function DraftSlotDialog({
  player,
  positions,
  slotInstances,
  drafted,
  onAssign,
  onClose,
}: {
  player: Player
  positions: Slot[]
  slotInstances: SlotInstance[]
  drafted: DraftedMap
  onAssign: (position: Slot) => void
  onClose: () => void
}) {
  const displayedEligiblePositions = getDisplayedEligiblePositions(player, slotInstances, drafted)

  return (
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="slot-drawer" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="slot-drawer-head">
          <div>
            <p className="section-kicker">Draft Card</p>
            <h2>{player.name}</h2>
          </div>
          <button type="button" className="button button-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="slot-drawer-summary">
          <p>{player.team}</p>
          <p>{formatCareerLabel(player)}</p>
          <p>Eligible: {displayedEligiblePositions.join(' - ')}</p>
        </div>

        <div className="slot-drawer-body">
          <p className="field-note">This player fits more than one open roster slot. Pick the spot you want to fill.</p>
          <div className="slot-choice-list">
            {positions.map((position) => (
              <button key={position} type="button" className="slot-choice" onClick={() => onAssign(position)}>
                <span>{position}</span>
                <strong>Draft into {position}</strong>
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  )
}

function ResultsHero({
  summaryRecord,
  totalScore,
  modeSummary,
  optimalSummary,
  simulationSummary,
  strengthPercentile,
  shareState,
  onShare,
  onGoHome,
  onDraftAgain,
  onViewBoard,
}: {
  summaryRecord: string
  totalScore: number
  modeSummary: string
  optimalSummary: OptimalSummary | null
  simulationSummary: SimulationSummary | null
  strengthPercentile: number
  shareState: ShareState
  onShare: () => void
  onGoHome: () => void
  onDraftAgain: () => void
  onViewBoard: () => void
}) {
  return (
    <>
      <div className="results-actionbar">
        <div className="results-actionbar-copy">
          <p className="section-kicker">Run Complete</p>
          <strong>Final season recap</strong>
        </div>

        <div className="results-actionbar-actions">
          <button type="button" className="button button-secondary" onClick={onGoHome}>
            Back Home
          </button>
          <button type="button" className="button button-secondary" onClick={onDraftAgain}>
            Draft Again
          </button>
          <button type="button" className="button button-secondary" onClick={onViewBoard}>
            View Full Board
          </button>
          <button type="button" className="button button-primary" onClick={onShare}>
            {shareState === 'shared'
              ? 'Shared'
              : shareState === 'copied'
                ? 'Copied Image'
                : shareState === 'downloaded'
                  ? 'Downloaded Image'
                  : 'Share Result'}
          </button>
        </div>
      </div>

      <section className="results-hero">
        <div className="results-hero-main share-card-preview">
          <span className="share-card-label">Share card preview</span>
          <p className="section-kicker">Season Recap</p>
          <h1>{summaryRecord}</h1>
          <p className="results-total-war">{formatPoints(totalScore)}</p>
          <p className="results-meta">{modeSummary}</p>
          <p className="results-hero-strength">
            Stronger than {strengthPercentile}% of the {simulationSummary?.sampleSize ?? 1000} simulated seasons.
          </p>
          {optimalSummary ? (
            <p className="results-hero-optimal">
              Optimal result on your boards: {optimalSummary.wins}-{optimalSummary.losses} at {formatPoints(optimalSummary.totalPoints)}
            </p>
          ) : null}
        </div>
      </section>
    </>
  )
}

function ResultsLineupSnapshot({
  draftedList,
}: {
  draftedList: DraftedEntry[]
}) {
  const lineup = draftedList.filter((entry) => entry.player?.category === 'hitter')
  const staff = draftedList.filter((entry) => entry.player?.category === 'pitcher')

  function renderGroup(title: string, entries: DraftedEntry[]) {
    return (
      <section className="results-depth-group">
        <div className="section-bar compact">
          <div>
            <p className="section-kicker">{title}</p>
          </div>
        </div>

        <div className="results-depth-list">
          {entries.map((entry) => (
            <div key={entry.key} className="results-depth-row">
              <span>{entry.label}</span>
              <div>
                <strong>{entry.player?.name ?? '-'}</strong>
                <small>{entry.player ? `${entry.player.team} - ${formatSeasonLabel(entry.player)}` : ''}</small>
              </div>
            </div>
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="results-depth-chart">
      {renderGroup('Starting Lineup', lineup)}
      {renderGroup('Pitching Staff', staff)}
    </section>
  )
}

function ResultsRosterTable({
  draftedList,
}: {
  draftedList: DraftedEntry[]
}) {
  return (
    <div className="results-table">
      <div className="results-table-head">
        <span>Slot</span>
        <span>Player</span>
        <span>School</span>
        <span>Years</span>
        <span>PTS</span>
      </div>

      {draftedList.map((entry) => (
        <div key={entry.key} className="results-table-row">
          <span data-label="Slot">{entry.label}</span>
          <strong data-label="Player">{entry.player?.name ?? '-'}</strong>
          <span data-label="School">{entry.player?.team ?? '-'}</span>
          <span data-label="Years">{entry.player ? formatSeasonLabel(entry.player) : '-'}</span>
          <b data-label="Points">{entry.player ? scoreFormatter.format(entry.player.value) : '-'}</b>
        </div>
      ))}
    </div>
  )
}

function RunSummaryPanel({
  currentEra,
  activeMode,
  leaderboardName,
  savedResult,
  simulationSummary,
  onLeaderboardNameChange,
  onSave,
  summary,
  totalScore,
}: {
  currentEra: Era
  activeMode: ModeConfig
  leaderboardName: string
  savedResult: boolean
  simulationSummary: SimulationSummary | null
  onLeaderboardNameChange: (value: string) => void
  onSave: () => void
  summary: ReturnType<typeof summarizeRoster>
  totalScore: number
}) {
  const summaryItems = [
    ['Best Player', summary.bestPlayer ? `${summary.bestPlayer.name}, ${formatPoints(summary.bestPlayer.value)}` : '-'],
    ['Best Hitter', summary.bestHitter?.name ?? '-'],
    ['Best Pitcher', summary.bestPitcher?.name ?? '-'],
    ['Weakest Spot', summary.weakestEntry ? `${summary.weakestEntry.label} - ${summary.weakestEntry.player.name}` : '-'],
    ['Average Points', formatPoints(summary.averageWar)],
    ['Roster Read', summary.strengthLabel],
  ] as const

  const recapRows = [
    ['Final Record', summary.recordLabel],
    ['Total Points', formatPoints(totalScore)],
    ['Era', currentEra],
    ['Mode', activeMode.label],
    ['Median Sim', simulationSummary ? formatPoints(simulationSummary.percentilePoints.p50) : '-'],
    ['90th Pctl Sim', simulationSummary ? formatPoints(simulationSummary.percentilePoints.p90) : '-'],
  ] as const

  return (
    <div className="results-sidebar">
      <section className="results-summary-grid">
        {summaryItems.map(([label, value]) => (
          <div key={label} className="results-summary-tile">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>

      <section className="results-panel">
          <div className="section-bar">
            <div>
              <p className="section-kicker">Save Run</p>
              <h3>Top 10 entry</h3>
            </div>
          </div>
        <div className="results-save-form">
          <input
            id="leaderboard-name"
            type="text"
            value={leaderboardName}
            onChange={(event) => onLeaderboardNameChange(event.target.value)}
            placeholder="Enter a leaderboard name"
            disabled={savedResult}
          />
          <button type="button" className="button button-primary button-block" onClick={onSave} disabled={savedResult || leaderboardName.trim().length === 0}>
            {savedResult ? 'Saved to leaderboard' : 'Save Run'}
          </button>
        </div>
      </section>

      <section className="results-panel">
          <div className="section-bar">
            <div>
              <p className="section-kicker">Season Recap</p>
              <h3>{summary.recordLabel} finish</h3>
            </div>
          </div>

        <div className="summary-list">
          {recapRows.map(([label, value]) => (
            <div key={label} className="summary-list-row">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function ResultsPage({
  activeMode,
  currentEra,
  draftedList,
  totalScore,
  projectedWins,
  projectedLosses,
  leaderboardName,
  savedResult,
  shareState,
  shareCardRef,
  optimalSummary,
  simulationSummary,
  strengthPercentile,
  onLeaderboardNameChange,
  onSave,
  onShare,
  onDraftAgain,
  onGoHome,
  onViewBoard,
}: {
  activeMode: ModeConfig
  currentEra: Era
  draftedList: DraftedEntry[]
  totalScore: number
  projectedWins: number
  projectedLosses: number
  leaderboardName: string
  savedResult: boolean
  shareState: ShareState
  shareCardRef: RefObject<HTMLDivElement | null>
  optimalSummary: OptimalSummary | null
  simulationSummary: SimulationSummary | null
  strengthPercentile: number
  onLeaderboardNameChange: (value: string) => void
  onSave: () => void
  onShare: () => void
  onDraftAgain: () => void
  onGoHome: () => void
  onViewBoard: () => void
}) {
  const summary = summarizeRoster(draftedList, totalScore, projectedWins, projectedLosses)

  return (
    <AppShell wide>
      <section className="results-page">
        <ResultsHero
          summaryRecord={summary.recordLabel}
          totalScore={totalScore}
          modeSummary={formatModeSummary(activeMode, currentEra)}
          optimalSummary={optimalSummary}
          simulationSummary={simulationSummary}
          strengthPercentile={strengthPercentile}
          shareState={shareState}
          onShare={onShare}
          onGoHome={onGoHome}
          onDraftAgain={onDraftAgain}
          onViewBoard={onViewBoard}
        />

        <div className="results-layout" id="results-share-card" ref={shareCardRef}>
          <section className="results-panel results-roster-panel">
            <ResultsLineupSnapshot draftedList={draftedList} />
            <div className="section-bar">
              <div>
                <p className="section-kicker">Final Lineup</p>
                <h2>Box score roster</h2>
              </div>
              <span>{draftedList.length}/13 drafted</span>
            </div>

            <ResultsRosterTable draftedList={draftedList} />

            {optimalSummary ? (
              <div className="results-optimal-block">
                <div className="section-bar">
                  <div>
                    <p className="section-kicker">Best Lineup Possible</p>
                    <h2>Optimal path from your boards</h2>
                  </div>
                  <span>
                    {optimalSummary.wins}-{optimalSummary.losses} • {formatPoints(optimalSummary.totalPoints)}
                  </span>
                </div>

                <ResultsLineupSnapshot draftedList={optimalSummary.draftedList} />
                <ResultsRosterTable draftedList={optimalSummary.draftedList} />
              </div>
            ) : null}
          </section>

          <RunSummaryPanel
            currentEra={currentEra}
            activeMode={activeMode}
            leaderboardName={leaderboardName}
            savedResult={savedResult}
            simulationSummary={simulationSummary}
            onLeaderboardNameChange={onLeaderboardNameChange}
            onSave={onSave}
            summary={summary}
            totalScore={totalScore}
          />
        </div>
      </section>
    </AppShell>
  )
}

function App() {
  const [players, setPlayers] = useState<Player[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedModeId, setSelectedModeId] = useState<ModeId | null>(null)
  const [drafted, setDrafted] = useState<DraftedMap>({})
  const [selectedPosition, setSelectedPosition] = useState<PositionFilter>('ALL')
  const [sortKey, setSortKey] = useState<SortKey>('rating')
  const [search, setSearch] = useState('')
  const [currentAssignment, setCurrentAssignment] = useState<DraftAssignment | null>(null)
  const [draftRounds, setDraftRounds] = useState<DraftRound[]>([])
  const [spinning, setSpinning] = useState(false)
  const [spinReason, setSpinReason] = useState<'advance' | 'team' | 'era' | 'start'>('start')
  const [pendingPlayer, setPendingPlayer] = useState<Player | null>(null)
  const [positionChoices, setPositionChoices] = useState<Slot[]>([])
  const [spinPreview, setSpinPreview] = useState<DraftAssignment | null>(null)
  const [leaderboards, setLeaderboards] = useState<Leaderboards>(createEmptyLeaderboards())
  const [showResultsView, setShowResultsView] = useState(false)
  const [leaderboardName, setLeaderboardName] = useState('')
  const [savedResult, setSavedResult] = useState(false)
  const [shareState, setShareState] = useState<ShareState>('idle')
  const shareCardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadData() {
      setLoading(true)
      const metaResponse = await fetch('/data/meta.generated.json')
      const nextMeta = (await metaResponse.json()) as Meta
      const chunkFiles = nextMeta.playerChunks?.length ? nextMeta.playerChunks : ['players.generated.json']
      const chunkResponses = await Promise.all(chunkFiles.map((fileName) => fetch(`/data/${fileName}`)))
      const chunkPayloads = (await Promise.all(chunkResponses.map((response) => response.json()))) as Player[][]
      const nextPlayers = chunkPayloads.flat()
      if (cancelled) return

      setMeta(nextMeta)
      setPlayers(nextPlayers)
      setLeaderboards(readLeaderboards())
      setLoading(false)
    }

    loadData()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (shareState === 'idle') return
    const timer = window.setTimeout(() => setShareState('idle'), 1800)
    return () => window.clearTimeout(timer)
  }, [shareState])

  const rosterSlots = meta?.rosterSlots ?? DEFAULT_ROSTER
  const slotInstances = useMemo(() => buildSlotInstances(rosterSlots), [rosterSlots])
  const activeMode = selectedModeId ? MODE_CONFIG[selectedModeId] : null
  const simulationSummary = useMemo(() => buildSimulationSummary(players, slotInstances, selectedModeId), [players, selectedModeId, slotInstances])
  const universalBests = useMemo<UniversalBestMap>(() => {
    const entries = (Object.keys(MODE_CONFIG) as ModeId[]).map((modeId) => {
      const modeSimulation = buildSimulationSummary(players, slotInstances, modeId)
      return [modeId, buildUniversalOptimalSummary(players, slotInstances, modeId, modeSimulation)] as const
    })

    return Object.fromEntries(entries)
  }, [players, slotInstances])
  const optimalSummary = useMemo(
    () => buildRunOptimalSummary(draftRounds, slotInstances, simulationSummary),
    [draftRounds, simulationSummary, slotInstances],
  )
  const availableAssignments = useMemo(
    () => buildAssignments(players, drafted, slotInstances, selectedModeId),
    [drafted, players, selectedModeId, slotInstances],
  )
  const totalScore = useMemo(() => Object.values(drafted).reduce((sum, player) => sum + player.value, 0), [drafted])
  const completed = Object.keys(drafted).length >= slotInstances.length
  const strengthPercentile = useMemo(
    () => percentileFromSortedTotals(simulationSummary?.totals ?? [], totalScore),
    [simulationSummary, totalScore],
  )
  const projectedWins = estimateWinsFromPercentile(strengthPercentile)
  const projectedLosses = estimateLossesFromPercentile(strengthPercentile)

  useEffect(() => {
    if (!selectedModeId || loading || completed || !spinning || availableAssignments.length === 0) return

    const previewTimer = window.setInterval(() => {
      setSpinPreview(choice(availableAssignments))
    }, 95)

    const settleTimer = window.setTimeout(() => {
      window.clearInterval(previewTimer)

      const nextAssignment =
        spinReason === 'team'
          ? selectTeamRespinAssignment(availableAssignments, currentAssignment)
          : spinReason === 'era'
            ? selectEraRespinAssignment(availableAssignments, currentAssignment)
            : selectRandomAssignment(availableAssignments, currentAssignment)

      setCurrentAssignment(nextAssignment)
      setSpinPreview(nextAssignment)
      setSpinning(false)
    }, 980)

    return () => {
      window.clearInterval(previewTimer)
      window.clearTimeout(settleTimer)
    }
  }, [availableAssignments, completed, currentAssignment, loading, selectedModeId, spinReason, spinning])

  const assignmentPool = useMemo(
    () => getAssignmentPoolResult(players, currentAssignment, selectedModeId, drafted, slotInstances, spinning),
    [currentAssignment, drafted, players, selectedModeId, slotInstances, spinning],
  )

  const assignmentPlayers = assignmentPool.players

  const filteredPlayers = useMemo(() => {
    const term = search.trim().toLowerCase()
    const filtered = assignmentPlayers
      .filter((player) => selectedPosition === 'ALL' || player.eligiblePositions.includes(selectedPosition))
      .filter((player) => {
        if (!term) return true
        return [player.name, player.team, player.conference, player.classYear, player.primaryPosition]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(term))
      })

    return filtered.sort((left, right) => {
      if (activeMode?.draftMode === 'hard') return left.name.localeCompare(right.name)
      if (sortKey === 'rating') {
        return right.value - left.value || getPlayerVolume(right) - getPlayerVolume(left) || left.name.localeCompare(right.name)
      }
      if (sortKey === 'era' || sortKey === 'whip') {
        return getSortValue(left, sortKey) - getSortValue(right, sortKey) || right.value - left.value || getPlayerVolume(right) - getPlayerVolume(left)
      }
      return getSortValue(right, sortKey) - getSortValue(left, sortKey) || right.value - left.value || getPlayerVolume(right) - getPlayerVolume(left)
    })
  }, [activeMode?.draftMode, assignmentPlayers, search, selectedPosition, sortKey])

  const draftedList = useMemo(
    () =>
      slotInstances
        .map((entry) => ({
          ...entry,
          player: drafted[entry.key] ?? null,
        }))
        .filter((entry) => entry.player),
    [drafted, slotInstances],
  )
  const draftedCount = Object.keys(drafted).length

  function clearRunState() {
    setDrafted({})
    setDraftRounds([])
    setSelectedPosition('ALL')
    setSortKey('rating')
    setSearch('')
    setPendingPlayer(null)
    setPositionChoices([])
    setLeaderboardName('')
    setSavedResult(false)
    setShareState('idle')
    setShowResultsView(false)
    setCurrentAssignment(null)
    setSpinPreview(null)
  }

  function startMode(modeId: ModeId) {
    setSelectedModeId(modeId)
    clearRunState()
    setSpinReason('start')
    setSpinning(true)
  }

  function goHome() {
    setSelectedModeId(null)
    clearRunState()
    setSpinning(false)
  }

  function triggerSpin(reason: 'advance' | 'team' | 'era' | 'start') {
    if (completed || availableAssignments.length === 0) return
    setSpinReason(reason)
    setSpinning(true)
  }

  function assignPlayer(player: Player, position: Slot) {
    const slotKey = getSlotKeyForPosition(position, slotInstances, drafted)
    if (!slotKey) return
    const willCompleteRoster = Object.keys(drafted).length + 1 >= slotInstances.length
    const roundAssignment = currentAssignment
    const roundCandidates = [...assignmentPlayers]

    setPendingPlayer(null)
    setPositionChoices([])
    setDrafted((current) => ({ ...current, [slotKey]: player }))
    if (roundAssignment) {
      setDraftRounds((current) => [...current, { assignment: roundAssignment, candidates: roundCandidates }])
    }
    if (!willCompleteRoster) {
      triggerSpin('advance')
    } else {
      setShowResultsView(true)
    }
  }

  function handleDraftPlayer(player: Player) {
    const openPositions = getOpenPositionsForPlayer(player, slotInstances, drafted)
    if (openPositions.length === 0) return
    if (openPositions.length === 1) {
      assignPlayer(player, openPositions[0])
      return
    }

    setPendingPlayer(player)
    setPositionChoices(openPositions)
  }

  function resetDraft() {
    if (!selectedModeId) return
    startMode(selectedModeId)
  }

  function saveLeaderboard() {
    if (!selectedModeId || savedResult) return
    const name = leaderboardName.trim()
    if (!name) return

    const entry: LeaderboardEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      wins: projectedWins,
      losses: projectedLosses,
      war: Number(totalScore.toFixed(1)),
      createdAt: new Date().toISOString(),
    }

    const next = {
      ...leaderboards,
      [selectedModeId]: sortLeaderboard([...leaderboards[selectedModeId], entry]),
    }

    setLeaderboards(next)
    writeLeaderboards(next)
    setSavedResult(true)
  }

  async function shareResult() {
    const shareText = [
      '56-0 College Baseball Run Complete',
      `Record: ${projectedWins}-${projectedLosses}`,
      `Mode: ${activeMode?.label ?? 'Unknown'}`,
      `Draw: ${currentAssignment?.label ?? 'Random draw'}`,
      `Era: ${currentAssignment?.era ?? activeMode?.eraFilter ?? DEFAULT_ERAS[0]}`,
      `Total Points: ${scoreFormatter.format(totalScore)}`,
    ].join('\n')

    try {
      const target = shareCardRef.current ?? document.getElementById('results-share-card')
      if (!target) {
        throw new Error('Missing share card')
      }

      const imageBlob = await renderElementToPng(target)
      const imageFile = new File([imageBlob], `56-0-${projectedWins}-${projectedLosses}.png`, { type: 'image/png' })

      if (navigator.share && navigator.canShare?.({ files: [imageFile] })) {
        await navigator.share({
          files: [imageFile],
          title: '56-0 College Baseball Run',
          text: shareText,
        })
        setShareState('shared')
        return
      }

      if (navigator.clipboard && 'ClipboardItem' in window) {
        await navigator.clipboard.write([
          new ClipboardItem({
            [imageBlob.type]: imageBlob,
          }),
        ])
        setShareState('copied')
        return
      }

      const url = URL.createObjectURL(imageBlob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = imageFile.name
      anchor.click()
      URL.revokeObjectURL(url)
      setShareState('downloaded')
    } catch {
      setShareState('unsupported')
    }
  }

  if (loading) {
    return <LoadingScreen />
  }

  if (!selectedModeId || !activeMode) {
    return <LandingPage leaderboards={leaderboards} onStart={startMode} universalBests={universalBests} />
  }

  const displayAssignment = spinning ? spinPreview : currentAssignment
  const currentEra = displayAssignment?.era ?? activeMode.eraFilter ?? DEFAULT_ERAS[0]
  const candidateLogoSlug =
    displayAssignment?.kind === 'power5'
      ? assignmentPlayers.find((player) => player.team === displayAssignment.team)?.logoSlug ?? null
      : null

  if (completed && showResultsView) {
    return (
      <ResultsPage
        activeMode={activeMode}
        currentEra={currentEra}
        draftedList={draftedList}
        totalScore={totalScore}
        projectedWins={projectedWins}
        projectedLosses={projectedLosses}
        leaderboardName={leaderboardName}
        savedResult={savedResult}
        shareState={shareState}
        shareCardRef={shareCardRef}
        optimalSummary={optimalSummary}
        simulationSummary={simulationSummary}
        strengthPercentile={strengthPercentile}
        onLeaderboardNameChange={setLeaderboardName}
        onSave={saveLeaderboard}
        onShare={shareResult}
        onDraftAgain={resetDraft}
        onGoHome={goHome}
        onViewBoard={() => setShowResultsView(false)}
      />
    )
  }

  return (
    <>
      <CandidateBoardPage
        activeMode={activeMode}
        assignment={displayAssignment}
        currentEra={currentEra}
        candidateLogoSlug={candidateLogoSlug}
        spinning={spinning}
        meta={meta}
        filteredPlayers={filteredPlayers}
        drafted={drafted}
        usedFallback={assignmentPool.usedFallback}
        fallbackLabel={assignmentPool.fallbackLabel}
        draftedCount={draftedCount}
        selectedPosition={selectedPosition}
        setSelectedPosition={setSelectedPosition}
        sortKey={sortKey}
        setSortKey={setSortKey}
        search={search}
        setSearch={setSearch}
        slotInstances={slotInstances}
        onGoHome={goHome}
        onReset={resetDraft}
        onSpinTeam={() => triggerSpin('team')}
        onSpinEra={() => triggerSpin('era')}
        onDraft={handleDraftPlayer}
      />

      {pendingPlayer ? (
        <DraftSlotDialog
          player={pendingPlayer}
          positions={positionChoices}
          slotInstances={slotInstances}
          drafted={drafted}
          onAssign={(position) => assignPlayer(pendingPlayer, position)}
          onClose={() => setPendingPlayer(null)}
        />
      ) : null}

      {shareState === 'unsupported' ? (
        <div className="toast-message" role="status">
          Image sharing is not supported in this browser session. You can still save the run manually.
        </div>
      ) : null}
    </>
  )
}

export default App

