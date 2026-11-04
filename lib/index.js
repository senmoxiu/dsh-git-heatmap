/**
 * @senmoxiu/dsh-git-heatmap — host half.
 *
 * Runs in the DSH host process: owns the `/git-heat/*` routes, the repository
 * discovery, and every git subprocess the heatmap needs. The browser half
 * (exports "./client") never touches git; it asks these routes for facts.
 *
 * Counting policy ("local honest"): an author email must be in IDENTITY.aliases,
 * all refs are walked (`--all`), rows are de-duplicated globally by SHA, merge
 * commits count, and a commit's day is resolved in TIMEZONE. Measured on this
 * machine: 23,933 commits across 34 repositories, of which 694 belong to the
 * configured identity — without the email filter 97% of the grid would be other
 * people's work.
 *
 * No build step and no runtime dependencies on purpose: this file is the
 * shipped artifact. Only `node:` builtins are imported.
 * @module @senmoxiu/dsh-git-heatmap
 */

import { readdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Route prefix. Must not collide with git-graph's `/git` (prefix) + `/git/events` (exact). */
const PREFIX = '/git-heat'

/** Collected-output cap for a short command. */
const OUTPUT_CAP_BYTES = 1 << 20

/**
 * Collected-output cap for `git log`. One repository here emits 2.85 MB for
 * 11,107 commits; the 1 MiB default would silently truncate the stream and the
 * parser would report a partial history as the truth.
 */
const LOG_CAP_BYTES = 64 << 20

/**
 * Locale every git child runs under. Pinning to C keeps git's own messages the
 * English strings our error classification is written against, on a zh_CN host
 * too. Deliberate exception to the ambient environment, not a general locale
 * policy: it only ever covers git children.
 */
const GIT_CHILD_ENV = { LC_ALL: 'C', LANG: 'C' }

/** Probe deadline; the abort reaches the subprocess tree. */
const PROBE_TIMEOUT_MS = 8_000
/** `git log` deadline. An 11k-commit repository measured 253-267 ms; 2 min is slack. */
const LOG_TIMEOUT_MS = 120_000

/**
 * Spawn argv for git. On win32 the executable must be `git.exe`: the `.cmd`
 * shim cannot be launched by a shell-less spawn, and going through cmd.exe
 * would expand the `%` in `--format=%H`.
 * @param args - git arguments after the executable.
 * @returns the full argv handed to the subprocess service.
 */
const gitArgv = (args) => (process.platform === 'win32' ? ['git.exe', ...args] : ['git', ...args])

/** Default scan roots. */
const DEFAULT_ROOTS = ['D:/项目', 'D:/笔记']

/** The identity set the heatmap counts. See research/02-git-data.md §5.1. */
const IDENTITY = {
  primaryEmail: '2801251352@qq.com',
  aliases: ['2801251352@qq.com'],
  names: ['森修', 'senxiu'],
}

/** Fixed bucket timezone. 22.8% of this machine's commits fall on a different day than their author-local one. */
const TIMEZONE = 'Asia/Shanghai'

/** Rolling window width in weeks. */
const WEEKS = 53

/** Result cache lifetime; a cold build re-runs every repository's log. */
const CACHE_TTL_MS = 300_000

/** Concurrency for the per-repository `git log` fan-out. */
const LOG_CONCURRENCY = 6

/** Directories never descended into. `.git` matters most: `.git/modules/<sub>` would look like a repo. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', 'dist', 'build', 'target',
  'vendor', '.next', '.nuxt', '.cache', '.gradle', '.turbo', '.tmp-work', '.tmp',
])

/** Per-repository `git log` field order, separated by the ASCII Unit Separator. */
const LOG_FORMAT = '--format=%H%x1f%h%x1f%at%x1f%an%x1f%ae%x1f%P%x1f%s'

/** Cached model plus the inputs it was built from. */
let cache = { key: '', at: 0, model: null }

// --------------------------------------------------------------------- helpers

/** Loopback-only trust fence: these routes read the whole machine's repositories. */
function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Write one JSON envelope.
 * @param response - the server response.
 * @param status - HTTP status.
 * @param payload - the envelope body.
 */
function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}

/** The `{ok:true,value}` envelope. */
const ok = (value) => ({ ok: true, value })

/** The `{ok:false,error}` envelope with a stable code. */
const fail = (code, message) => ({ ok: false, error: { code, message } })

/**
 * Read a JSON request body with a size cap.
 * @param request - the incoming request.
 * @param maxBytes - hard cap; over it the request is destroyed.
 * @returns the parsed body, or null when unreadable/oversized.
 */
function readJsonBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        settle(null)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (size === 0) {
        settle({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settle(typeof parsed === 'object' && parsed !== null ? parsed : null)
      } catch {
        settle(null)
      }
    })
    request.on('error', () => settle(null))
  })
}

/**
 * Run one git command through the managed subprocess service.
 * @param ctx - context carrying `subprocess`.
 * @param args - git arguments after the executable.
 * @param cwd - working directory.
 * @param timeoutMs - abort deadline.
 * @param capBytes - per-stream collection cap.
 * @returns exit code plus both streams.
 */
async function runGit(ctx, args, cwd, timeoutMs = PROBE_TIMEOUT_MS, capBytes = OUTPUT_CAP_BYTES) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const spec = {
      argv: gitArgv(args),
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: capBytes },
        stderr: { maxBytes: OUTPUT_CAP_BYTES },
      },
      graceMs: 10_000,
      signal: controller.signal,
      env: GIT_CHILD_ENV,
    }
    const handle = ctx.subprocess.spawn(spec)
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, stdout, stderr, timedOut: false }
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: controller.signal.aborted,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run at most `limit` async jobs at a time, preserving input order.
 * @param items - the work items.
 * @param limit - concurrency cap.
 * @param worker - the async job.
 * @returns results in input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Normalize a Windows path to forward slashes for display and stable ids. */
const displayPath = (path) => path.replace(/\\/g, '/')

// ------------------------------------------------------------- repo discovery

/**
 * Find every git repository under the given roots by looking for a `.git`
 * entry — never by spawning a process (a git.exe start costs ~96 ms here).
 *
 * Both shapes are recognized: a `.git` DIRECTORY is a normal checkout, a `.git`
 * FILE is a linked worktree or a submodule. Found repositories are still
 * descended into, because this machine really has a repository inside another.
 * @param roots - directories to scan.
 * @param options - depth and skip set.
 * @returns discovered checkouts plus the directories that failed to list.
 */
async function discoverRepos(roots, options = {}) {
  const maxDepth = options.maxDepth ?? 6
  const skip = options.skip ?? SKIP_DIRS
  const found = []
  const errors = []
  for (const root of roots) {
    let start
    try {
      start = await realpath(root)
    } catch (error) {
      errors.push({ dir: root, code: error?.code ?? 'unresolved' })
      continue
    }
    const stack = [{ dir: start, depth: 0 }]
    while (stack.length > 0) {
      const current = stack.pop()
      let entries
      try {
        entries = await readdir(current.dir, { withFileTypes: true })
      } catch (error) {
        // A pip leftover with a broken ACL must not abort the whole scan.
        errors.push({ dir: displayPath(current.dir), code: error?.code ?? 'read-failed' })
        continue
      }
      const gitEntry = entries.find((entry) => entry.name === '.git')
      if (gitEntry !== undefined) {
        found.push({
          workdir: displayPath(current.dir),
          root: displayPath(root),
          depth: current.depth,
          gitKind: gitEntry.isDirectory() ? 'dir' : 'file',
        })
      }
      if (current.depth >= maxDepth) continue
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (skip.has(entry.name)) continue
        stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
      }
    }
  }
  return { found, errors }
}

// ------------------------------------------------------------- commit reading

/**
 * Parse one `git log` stdout into rows.
 * @param stdout - the raw output.
 * @returns parsed rows; malformed lines are dropped.
 */
function parseLog(stdout) {
  const rows = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const parts = line.split('\x1f')
    if (parts.length < 7) continue
    const at = Number(parts[2])
    if (!Number.isFinite(at)) continue
    rows.push({
      sha: parts[0],
      short: parts[1],
      at,
      authorName: parts[3],
      authorEmail: parts[4],
      parents: parts[5] === '' ? [] : parts[5].split(' '),
      subject: parts[6],
    })
  }
  return rows
}

/** `git log` on a freshly initialised repository is not a failure. */
const EMPTY_REPO = /does not have any commits yet|no commits yet|bad default revision/i

/**
 * Read every reachable commit of one repository.
 * @param ctx - context carrying `subprocess`.
 * @param repo - the discovered checkout.
 * @returns rows plus an error string (null when fine).
 */
async function readRepoLog(ctx, repo) {
  const result = await runGit(ctx, ['log', '--all', '--date-order', LOG_FORMAT], repo.workdir, LOG_TIMEOUT_MS, LOG_CAP_BYTES)
  if (result.exitCode === 0) return { rows: parseLog(result.stdout), error: null }
  const stderr = (result.stderr || '').trim()
  if (EMPTY_REPO.test(stderr)) return { rows: [], error: null }
  return { rows: [], error: (stderr || `git log exited ${result.exitCode}`).slice(0, 300) }
}

// --------------------------------------------------------------- model build

/** One shared formatter; constructing it per commit is the slow path. */
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})

/**
 * Resolve an epoch second to its `YYYY-MM-DD` day in TIMEZONE.
 *
 * Never derive this from an ISO string's own offset: 1048 commits on this
 * machine end with `Z`, and slicing the offset yields NaN.
 * @param at - epoch seconds.
 * @returns the day key.
 */
const dayOf = (at) => dayFormatter.format(new Date(at * 1000))

/** `YYYY-MM-DD` for a local Date (never `toISOString`, which is UTC). */
function keyOf(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A Date at local noon: DST-safe when adding days. */
const atNoon = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)

/** Add days to a local date. */
const addDays = (date, days) => atNoon(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days))

/**
 * The rolling window: Monday-start, exactly `weeks` columns ending on the
 * Sunday of the current week.
 * @param today - reference day.
 * @param weeks - column count.
 * @returns first and last day keys.
 */
function windowOf(today, weeks) {
  const mondayIndex = (today.getDay() + 6) % 7
  const last = addDays(today, 6 - mondayIndex)
  const first = addDays(last, -(weeks * 7 - 1))
  return { from: keyOf(first), to: keyOf(last) }
}

/**
 * Nearest-rank quantiles over the non-zero day counts, matching the thresholds
 * measured in research/02-git-data.md (q1=2, q2=4, q3=8).
 * @param ascending - sorted ascending non-zero day counts.
 * @returns the three cut points, kept strictly increasing so all five levels stay reachable.
 */
function quantiles(ascending) {
  if (ascending.length === 0) return { q1: 1, q2: 2, q3: 3 }
  const at = (fraction) => ascending[Math.min(ascending.length - 1, Math.max(0, Math.floor(fraction * ascending.length)))]
  const q1 = at(0.25)
  const q2 = at(0.5)
  const q3 = at(0.75)
  return { q1, q2: Math.max(q2, q1 + 1), q3: Math.max(q3, q2 + 2) }
}

/**
 * Longest run of consecutive active days.
 * @param ascending - ascending `YYYY-MM-DD` keys.
 * @returns the streak length.
 */
function longestStreak(ascending) {
  let best = 0
  let run = 0
  let previous = null
  for (const day of ascending) {
    const current = new Date(`${day}T12:00:00`)
    if (previous === null) {
      run = 1
    } else {
      const gap = Math.round((current.getTime() - previous.getTime()) / 86_400_000)
      run = gap === 1 ? run + 1 : 1
    }
    if (run > best) best = run
    previous = current
  }
  return best
}

/**
 * Classify a repository by evidence rather than by name: a large author set or
 * foreign root commits with a negligible share of mine means upstream history;
 * some foreign roots means team history; none means this checkout is mine.
 * @param draft - counts gathered for one repository.
 * @returns the origin kind.
 */
function classifyOrigin(draft) {
  if (draft.commitCount === 0) return 'empty'
  if (draft.authorCount >= 20 || (draft.hasForeignRoot && draft.myRatio < 0.05)) return 'upstream'
  return draft.hasForeignRoot ? 'team' : 'own'
}

/**
 * Build the whole model: discover, read every repository, aggregate.
 * @param ctx - context carrying `subprocess`.
 * @param roots - scan roots.
 * @returns the model plus non-fatal diagnostics.
 */
async function buildModel(ctx, roots) {
  const startedAt = Date.now()
  const discovery = await discoverRepos(roots)
  const checkouts = discovery.found.filter((repo) => repo.gitKind === 'dir')
  const skippedNonDir = discovery.found.filter((repo) => repo.gitKind !== 'dir').map((repo) => repo.workdir)

  const aliases = new Set(IDENTITY.aliases.map((email) => email.toLowerCase()))
  const logs = await mapLimit(checkouts, LOG_CONCURRENCY, (repo) => readRepoLog(ctx, repo))

  const seenSha = new Set()
  const repos = []
  const commits = []
  let commitCountAllRepos = 0
  let crossRepoDuplicates = 0
  const failures = []

  for (let index = 0; index < checkouts.length; index += 1) {
    const checkout = checkouts[index]
    const log = logs[index]
    if (log.error !== null) failures.push({ workdir: checkout.workdir, error: log.error })
    const rows = log.rows
    commitCountAllRepos += rows.length

    const authors = new Set()
    let mine = 0
    let hasForeignRoot = false
    let rootCount = 0
    let lastCommitAt = null
    for (const row of rows) {
      const email = row.authorEmail.toLowerCase()
      authors.add(email)
      if (row.parents.length === 0) {
        rootCount += 1
        if (!aliases.has(email)) hasForeignRoot = true
      }
      if (lastCommitAt === null || row.at > lastCommitAt) lastCommitAt = row.at
      if (!aliases.has(email)) continue
      mine += 1
      if (seenSha.has(row.sha)) {
        crossRepoDuplicates += 1
        continue
      }
      seenSha.add(row.sha)
      commits.push({ ...row, repoId: `r${index + 1}` })
    }

    const draft = {
      id: `r${index + 1}`,
      name: basename(checkout.workdir),
      workdir: checkout.workdir,
      commitCount: rows.length,
      myCommitCount: mine,
      authorCount: authors.size,
      rootCount,
      hasForeignRoot,
      myRatio: rows.length === 0 ? 0 : mine / rows.length,
      lastCommitAt,
    }
    draft.originKind = classifyOrigin(draft)
    repos.push(draft)
  }

  // Bucket the surviving (mine, globally unique) commits by day in TIMEZONE.
  const dayMap = new Map()
  for (const row of commits) {
    row.day = dayOf(row.at)
    const bucket = dayMap.get(row.day) ?? { date: row.day, count: 0, repos: {} }
    bucket.count += 1
    bucket.repos[row.repoId] = (bucket.repos[row.repoId] ?? 0) + 1
    dayMap.set(row.day, bucket)
  }

  const days = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const thresholds = quantiles(days.map((day) => day.count).sort((a, b) => a - b))
  for (const day of days) {
    if (day.count <= 0) day.level = 0
    else if (day.count <= thresholds.q1) day.level = 1
    else if (day.count <= thresholds.q2) day.level = 2
    else if (day.count <= thresholds.q3) day.level = 3
    else day.level = 4
  }

  const busiest = days.reduce((best, day) => (best === null || day.count > best.count ? day : best), null)
  const stats = {
    repoCount: checkouts.length,
    repoWithOwnCommits: repos.filter((repo) => repo.myCommitCount > 0).length,
    commitCountAllRepos,
    commitCountMine: commits.length,
    crossRepoDuplicates,
    dayCount: days.length,
    maxPerDay: busiest === null ? 0 : busiest.count,
    longestStreak: longestStreak(days.map((day) => day.date)),
    busiest: busiest === null ? null : { date: busiest.date, count: busiest.count },
    levelThresholds: thresholds,
  }

  return {
    model: {
      schemaVersion: 1,
      stage: 'M2',
      generatedAt: new Date().toISOString(),
      timezone: TIMEZONE,
      weeks: WEEKS,
      range: windowOf(new Date(), WEEKS),
      stats,
      repos: repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        workdir: repo.workdir,
        commitCount: repo.commitCount,
        myCommitCount: repo.myCommitCount,
        authorCount: repo.authorCount,
        originKind: repo.originKind,
        myRatio: Number(repo.myRatio.toFixed(4)),
        lastCommitAt: repo.lastCommitAt,
      })),
      days,
      commits: commits.map((row) => ({
        sha: row.sha,
        short: row.short,
        repoId: row.repoId,
        at: row.at,
        day: row.day,
        subject: row.subject,
        authorName: row.authorName,
      })),
    },
    diagnostics: {
      elapsedMs: Date.now() - startedAt,
      roots,
      checkouts: checkouts.length,
      skippedNonDir,
      readErrors: discovery.errors.slice(0, 10),
      gitFailures: failures,
    },
  }
}

// ---------------------------------------------------------------------- mount

/** Required services: the route registry and the managed subprocess seam. */
export const inject = ['webServer', 'subprocess']

/**
 * Mount the routes. Everything registered here is released by the returned
 * disposer, so a profile reload never double-registers `/git-heat`.
 * @param ctx - context carrying `webServer` and `subprocess`.
 * @param config - the row's config (optional `roots` override).
 */
export function apply(ctx, config) {
  ctx.effect(() => {
    /** The roots this row scans. */
    const rootsOf = () => {
      const configured = config?.roots
      return Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_ROOTS
    }

    /**
     * M0: can the host process spawn git?
     * @returns the probe view.
     */
    const probe = async () => {
      const startedAt = Date.now()
      const result = await runGit(ctx, ['--version'], process.cwd())
      const elapsedMs = Date.now() - startedAt
      const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? ''
      const spawnOk = result.exitCode === 0 && firstLine !== ''
      return {
        spawnOk,
        gitVersion: spawnOk ? firstLine : null,
        exitCode: result.exitCode,
        elapsedMs,
        platform: process.platform,
        argv0: gitArgv(['--version'])[0],
        cwd: process.cwd(),
        timedOut: result.timedOut,
        stderr: result.stderr.trim().slice(0, 600),
      }
    }

    /** The static config view the page can introspect. */
    const configView = () => ({
      stage: 'M2',
      roots: rootsOf(),
      identity: IDENTITY,
      timezone: TIMEZONE,
      weeks: WEEKS,
      cacheTtlMs: CACHE_TTL_MS,
      dataLayer: 'wired',
    })

    /**
     * The model, served from cache unless stale or a refresh was asked for.
     * A cold build re-runs every repository's log (~1.5 s across 34 checkouts
     * at 6-way concurrency); the cache is what keeps the page snappy.
     * @param force - bypass the cache.
     * @returns the model view.
     */
    const heat = async (force) => {
      const key = rootsOf().join('|')
      const fresh = cache.model !== null && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS
      if (fresh && !force) return { ...cache.model, cached: true, elapsedMs: Date.now() - cache.at }
      const built = await buildModel(ctx, rootsOf())
      cache = { key, at: Date.now(), model: built.model }
      return { ...built.model, cached: false, elapsedMs: built.diagnostics.elapsedMs, diagnostics: built.diagnostics }
    }

    /**
     * One handler for the whole prefix: trust fence, method, content-type,
     * then dispatch on the pathname.
     * @param request - the incoming request.
     * @param response - the server response.
     */
    const handler = async (request, response) => {
      if (!isLoopback(request)) {
        writeJson(response, 403, fail('forbidden', 'loopback-only'))
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405)
        response.end()
        return
      }
      const contentType = request.headers['content-type'] ?? ''
      if (!contentType.toLowerCase().startsWith('application/json')) {
        response.writeHead(415)
        response.end()
        return
      }
      const body = await readJsonBody(request)
      if (body === null) {
        writeJson(response, 400, fail('bad-request', 'malformed or oversized body'))
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://x').pathname
      try {
        if (pathname === `${PREFIX}/config`) {
          writeJson(response, 200, ok(configView()))
          return
        }
        if (pathname === `${PREFIX}/probe`) {
          writeJson(response, 200, ok(await probe()))
          return
        }
        if (pathname === `${PREFIX}/heat`) {
          writeJson(response, 200, ok(await heat(body.refresh === true)))
          return
        }
        writeJson(response, 404, fail('not-found', `unknown route: ${pathname}`))
      } catch (error) {
        ctx.logger?.warn?.(`dsh-git-heatmap: ${pathname} failed: ${String(error)}`)
        writeJson(response, 500, fail('internal', error instanceof Error ? error.message : String(error)))
      }
    }

    const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
    ctx.logger?.info?.(`dsh-git-heatmap: routes mounted on ${PREFIX}`)
    return () => {
      try {
        dispose()
      } catch {
        // already gone; a reload must not fail on double dispose
      }
    }
  }, 'dsh-git-heatmap: /git-heat routes')
}
