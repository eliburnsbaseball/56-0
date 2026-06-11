const LEADERBOARD_KEY = 'global-leaderboards-v1'
const MODE_IDS = ['classic', 'hard', 'classic-2020s', 'hard-2020s']

function createEmptyLeaderboards() {
  return {
    classic: [],
    hard: [],
    'classic-2020s': [],
    'hard-2020s': [],
  }
}

function normalizeLeaderboards(parsed) {
  return {
    classic: Array.isArray(parsed?.classic) ? parsed.classic : [],
    hard: Array.isArray(parsed?.hard) ? parsed.hard : [],
    'classic-2020s': Array.isArray(parsed?.['classic-2020s']) ? parsed['classic-2020s'] : [],
    'hard-2020s': Array.isArray(parsed?.['hard-2020s']) ? parsed['hard-2020s'] : [],
  }
}

function sortLeaderboard(entries) {
  return [...entries]
    .sort((left, right) => right.wins - left.wins || right.war - left.war || left.createdAt.localeCompare(right.createdAt))
    .slice(0, 10)
}

function sanitizeEntry(entry) {
  const name = `${entry?.name ?? ''}`.trim().slice(0, 24)
  const wins = Number(entry?.wins ?? 0)
  const losses = Number(entry?.losses ?? 56)
  const war = Number(entry?.war ?? 0)
  const createdAt = `${entry?.createdAt ?? ''}` || new Date().toISOString()

  if (!name) return null
  if (!Number.isFinite(wins) || !Number.isFinite(losses) || !Number.isFinite(war)) return null

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    wins: Math.max(0, Math.min(56, Math.round(wins))),
    losses: Math.max(0, Math.min(56, Math.round(losses))),
    war: Math.round(war * 10) / 10,
    createdAt,
  }
}

async function readLeaderboards(env) {
  const raw = await env.COLLEGE_BASEBALL_LEADERBOARDS.get(LEADERBOARD_KEY, 'json')
  return normalizeLeaderboards(raw ?? createEmptyLeaderboards())
}

async function writeLeaderboards(env, leaderboards) {
  await env.COLLEGE_BASEBALL_LEADERBOARDS.put(LEADERBOARD_KEY, JSON.stringify(leaderboards))
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export async function onRequestGet(context) {
  const leaderboards = await readLeaderboards(context.env)
  return jsonResponse(leaderboards)
}

export async function onRequestPost(context) {
  try {
    const payload = await context.request.json()
    const modeId = payload?.modeId
    if (!MODE_IDS.includes(modeId)) {
      return jsonResponse({ error: 'Invalid mode.' }, 400)
    }

    const entry = sanitizeEntry(payload?.entry)
    if (!entry) {
      return jsonResponse({ error: 'Invalid leaderboard entry.' }, 400)
    }

    const leaderboards = await readLeaderboards(context.env)
    const next = {
      ...leaderboards,
      [modeId]: sortLeaderboard([...leaderboards[modeId], entry]),
    }

    await writeLeaderboards(context.env, next)
    return jsonResponse(next)
  } catch (error) {
    return jsonResponse({ error: 'Unable to update leaderboard.' }, 500)
  }
}
