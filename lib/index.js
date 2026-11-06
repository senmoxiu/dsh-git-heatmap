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

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

/**
 * The editable config lives in `$DSH_HOME/git-heatmap.json` (falling back to
 * `~/.dsh/git-heatmap.json`). A file was chosen over a Schemastery `Config`
 * deliberately: this package is installed by symlink, so its real path is
 * outside the profile and `import '@deepseek-ai/schemastery'` cannot resolve.
 * A JSON file keeps the plugin dependency-free and lets the settings route
 * write changes that take effect on the next request without a remount.
 */
const CONFIG_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'git-heatmap.json')

/**
 * Defaults. `concurrency` is 10 because a cold build spawns one git per
 * repository and each start costs ~100-600 ms on Windows: 34 checkouts at
 * 6-way took 3.6 s, at 10-way it is closer to 2 s.
 */
const DEFAULTS = {
  /**
   * Empty on purpose: this plugin ships with no knowledge of the machine it
   * runs on. A checkout path and an author email baked into the source would
   * leak whoever wrote it and mean nothing to anyone else. Both are set through
   * the in-page settings panel, and the model reports `setup` so the page can
   * say "not configured yet" instead of silently showing an empty grid.
   */
  roots: [],
  identity: {
    primaryEmail: '',
    aliases: [],
    names: [],
  },
  timezone: 'Asia/Shanghai',
  weeks: 53,
  maxDepth: 6,
  ttlSeconds: 300,
  concurrency: 10,
  /**
   * Remote contribution sources. Only the LOGIN lives here — tokens live in the
   * environment or the optional secrets file, never in this JSON.
   */
  remotes: {
    github: { login: '', enabled: false },
    gitee: { login: '', enabled: false },
  },
  /** Proxy for the remote providers; empty string means direct. */
  proxyUrl: '',
  /**
   * Colour scale. `mode: 'brand'` mixes the theme's brand colour (adapts to
   * skins); `github` is the classic green ramp; `custom` uses `levels`.
   */
  palette: {
    mode: 'brand',
    levels: ['#9be9a8', '#40c463', '#30a14e', '#216e39'],
    empty: '',
  },
  /** How day counts map to the four filled steps. */
  levels: {
    mode: 'quantile',
    absolute: [1, 3, 6],
  },
}

/** Environment variable each provider's token is read from, in priority order. */
const TOKEN_ENV = {
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  gitee: ['GITEE_TOKEN'],
}

/**
 * Optional secrets file for users who would rather not edit their system
 * environment just to run one plugin:
 * `{ "github": "ghp_…", "gitee": "…" }`. It is plaintext on disk, so the
 * environment variable always wins and the file is optional. The value is only
 * ever read into memory here and never written to a log or a response.
 */
const SECRETS_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'git-heatmap.secrets.json')

/** Cached secrets file contents plus the mtime they came from. */
let secretsState = { mtime: -1, value: {} }

/**
 * Read the optional secrets file, reloading only when it changes.
 * @returns an object of provider → token.
 */
function secretsOf() {
  let mtime = 0
  try {
    mtime = statSync(SECRETS_FILE).mtimeMs
  } catch {
    mtime = 0
  }
  if (mtime !== secretsState.mtime) {
    let parsed = {}
    if (mtime !== 0) {
      try {
        const raw = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'))
        if (raw !== null && typeof raw === 'object') parsed = raw
      } catch {
        parsed = {}
      }
    }
    secretsState = { mtime, value: parsed }
  }
  return secretsState.value
}

/**
 * Resolve a provider's token: environment first, then the optional secrets file.
 * @param provider - 'github' | 'gitee'.
 * @returns the token, or '' when unset.
 */
function tokenFor(provider) {
  for (const name of TOKEN_ENV[provider] ?? []) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  const fromFile = secretsOf()[provider]
  return typeof fromFile === 'string' ? fromFile.trim() : ''
}

/** Last config read plus the file mtime it came from; -1 forces the first read. */
let configState = { mtime: -1, value: null, file: null }

/** Clamp a number into an integer range, falling back when it is not finite. */
function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** A timezone is valid when the platform can format with it. */
function validTimezone(value) {
  if (typeof value !== 'string' || value === '') return DEFAULTS.timezone
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value })
    return value
  } catch {
    return DEFAULTS.timezone
  }
}

/**
 * Coerce whatever is on disk (or was posted) into a usable config. Every field
 * is validated independently so one bad value never discards the rest.
 * @param raw - the parsed file or request patch.
 * @returns the normalized config.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const identityRaw = source.identity !== null && typeof source.identity === 'object' ? source.identity : {}
  const roots = (Array.isArray(source.roots) ? source.roots : DEFAULTS.roots)
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim().replace(/\\/g, '/'))
  const aliases = (Array.isArray(identityRaw.aliases) ? identityRaw.aliases : DEFAULTS.identity.aliases)
    .filter((entry) => typeof entry === 'string' && entry.includes('@'))
    .map((entry) => entry.trim().toLowerCase())
  const names = (Array.isArray(identityRaw.names) ? identityRaw.names : DEFAULTS.identity.names)
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
  return {
    roots: roots.length > 0 ? roots : DEFAULTS.roots,
    identity: {
      primaryEmail: typeof identityRaw.primaryEmail === 'string' && identityRaw.primaryEmail.includes('@')
        ? identityRaw.primaryEmail.trim().toLowerCase()
        : DEFAULTS.identity.primaryEmail,
      aliases: aliases.length > 0 ? aliases : DEFAULTS.identity.aliases,
      names: names.length > 0 ? names : DEFAULTS.identity.names,
    },
    timezone: validTimezone(source.timezone),
    weeks: clampInt(source.weeks, DEFAULTS.weeks, 4, 104),
    maxDepth: clampInt(source.maxDepth, DEFAULTS.maxDepth, 1, 12),
    ttlSeconds: clampInt(source.ttlSeconds, DEFAULTS.ttlSeconds, 0, 86_400),
    concurrency: clampInt(source.concurrency, DEFAULTS.concurrency, 1, 16),
    remotes: normalizeRemotes(source.remotes),
    proxyUrl: typeof source.proxyUrl === 'string' && /^https?:\/\/[^/\s]+/i.test(source.proxyUrl.trim())
      ? source.proxyUrl.trim()
      : '',
    palette: normalizePalette(source.palette),
    levels: normalizeLevels(source.levels),
  }
}

/**
 * Normalize the remote-source section. Only logins are stored; tokens come from
 * the environment at call time.
 * @param raw - the `remotes` field.
 * @returns both providers, always present.
 */
function normalizeRemotes(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const one = (provider) => {
    const entry = source[provider] !== null && typeof source[provider] === 'object' ? source[provider] : {}
    const login = typeof entry.login === 'string' ? entry.login.trim() : ''
    return { login, enabled: entry.enabled === true && login !== '' }
  }
  return { github: one('github'), gitee: one('gitee') }
}

/**
 * A CSS colour is only accepted in a shape that cannot smuggle anything else in
 * (the value ends up in an inline style): hex, or a plain rgb()/hsl() triple.
 * Anything else falls back, so a paste cannot inject `url(...)` or `;`.
 * @param value - the candidate.
 * @returns the trimmed colour, or '' when unacceptable.
 */
function safeColor(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return text
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.\s,%/]+\)$/i.test(text)) return text
  return ''
}

/**
 * Normalize the colour palette.
 * @param raw - the `palette` field.
 * @returns a usable palette with four levels.
 */
function normalizePalette(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = ['brand', 'github', 'custom'].includes(source.mode) ? source.mode : DEFAULTS.palette.mode
  const levels = (Array.isArray(source.levels) ? source.levels : DEFAULTS.palette.levels)
    .map((entry) => safeColor(entry))
  while (levels.length < 4) levels.push(DEFAULTS.palette.levels[levels.length])
  return {
    mode,
    levels: levels.slice(0, 4).map((entry, index) => entry === '' ? DEFAULTS.palette.levels[index] : entry),
    empty: safeColor(source.empty),
  }
}

/**
 * Normalize how counts map onto the four steps.
 * @param raw - the `levels` field.
 * @returns the mode plus three strictly increasing absolute cut points.
 */
function normalizeLevels(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = ['quantile', 'absolute'].includes(source.mode) ? source.mode : DEFAULTS.levels.mode
  const rawAbsolute = Array.isArray(source.absolute) ? source.absolute : DEFAULTS.levels.absolute
  const absolute = [0, 1, 2].map((index) => clampInt(rawAbsolute[index], DEFAULTS.levels.absolute[index], 1, 100_000))
  // Keep them strictly increasing so all five steps stay reachable.
  absolute[1] = Math.max(absolute[1], absolute[0] + 1)
  absolute[2] = Math.max(absolute[2], absolute[1] + 1)
  return { mode, absolute }
}

/**
 * The effective config, re-read from disk whenever the file's mtime changes so
 * an external edit is picked up without a restart.
 * @returns the normalized config plus where it came from.
 */
function effectiveConfig() {
  let mtime = 0
  try {
    mtime = statSync(CONFIG_FILE).mtimeMs
  } catch {
    mtime = 0
  }
  if (mtime !== configState.mtime) {
    let parsed = null
    if (mtime !== 0) {
      try {
        parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      } catch {
        parsed = null
      }
    }
    configState = { mtime, value: normalizeConfig(parsed), file: mtime === 0 ? null : CONFIG_FILE }
  }
  return configState
}

/**
 * Drop invalid fields from a patch. Without this, posting `{weeks: "nope"}`
 * would overwrite the stored value and then fall back to the DEFAULT (53),
 * silently resetting a user's 26-week preference instead of ignoring one bad
 * field.
 * @param patch - the request body.
 * @returns only the fields that are individually valid.
 */
function sanitizePatch(patch) {
  if (patch === null || typeof patch !== 'object') return {}
  const out = {}
  if (Array.isArray(patch.roots)) {
    const roots = patch.roots.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    if (roots.length > 0) out.roots = roots
  }
  if (patch.identity !== null && typeof patch.identity === 'object') {
    const identity = {}
    if (typeof patch.identity.primaryEmail === 'string' && patch.identity.primaryEmail.includes('@')) identity.primaryEmail = patch.identity.primaryEmail
    if (Array.isArray(patch.identity.aliases)) {
      const aliases = patch.identity.aliases.filter((entry) => typeof entry === 'string' && entry.includes('@'))
      if (aliases.length > 0) identity.aliases = aliases
    }
    if (Array.isArray(patch.identity.names)) {
      const names = patch.identity.names.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      if (names.length > 0) identity.names = names
    }
    if (Object.keys(identity).length > 0) out.identity = identity
  }
  if (typeof patch.timezone === 'string' && patch.timezone !== '' && validTimezone(patch.timezone) === patch.timezone) {
    out.timezone = patch.timezone
  }
  for (const [key, min, max] of [['weeks', 4, 104], ['maxDepth', 1, 12], ['ttlSeconds', 0, 86_400], ['concurrency', 1, 16]]) {
    const value = Number(patch[key])
    if (Number.isFinite(value)) out[key] = Math.min(max, Math.max(min, Math.round(value)))
  }
  if (patch.remotes !== null && typeof patch.remotes === 'object') {
    const remotes = {}
    for (const provider of ['github', 'gitee']) {
      const entry = patch.remotes[provider]
      if (entry === null || typeof entry !== 'object') continue
      const clean = {}
      if (typeof entry.login === 'string') clean.login = entry.login.trim()
      if (typeof entry.enabled === 'boolean') clean.enabled = entry.enabled
      if (Object.keys(clean).length > 0) remotes[provider] = clean
    }
    if (Object.keys(remotes).length > 0) out.remotes = remotes
  }
  if (typeof patch.proxyUrl === 'string') out.proxyUrl = patch.proxyUrl.trim()
  if (patch.palette !== null && typeof patch.palette === 'object') {
    const clean = {}
    if (['brand', 'github', 'custom'].includes(patch.palette.mode)) clean.mode = patch.palette.mode
    if (Array.isArray(patch.palette.levels)) clean.levels = patch.palette.levels
    if (typeof patch.palette.empty === 'string') clean.empty = patch.palette.empty
    if (Object.keys(clean).length > 0) out.palette = clean
  }
  if (patch.levels !== null && typeof patch.levels === 'object') {
    const clean = {}
    if (['quantile', 'absolute'].includes(patch.levels.mode)) clean.mode = patch.levels.mode
    if (Array.isArray(patch.levels.absolute)) clean.absolute = patch.levels.absolute
    if (Object.keys(clean).length > 0) out.levels = clean
  }
  return out
}

/**
 * Write provider tokens to the secrets file. A token is only ever written here
 * (never into the config file, never into a response); an empty string clears
 * the stored value, and `undefined` leaves it untouched.
 * @param patch - `{ github?: string, gitee?: string }`.
 * @returns which providers now have a token.
 */
function writeSecrets(patch) {
  if (patch === null || typeof patch !== 'object') return { github: tokenFor('github') !== '', gitee: tokenFor('gitee') !== '' }
  const current = { ...secretsOf() }
  let changed = false
  for (const provider of ['github', 'gitee']) {
    const value = patch[provider]
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text === '') {
      if (current[provider] !== undefined) {
        delete current[provider]
        changed = true
      }
      continue
    }
    if (current[provider] !== text) {
      current[provider] = text
      changed = true
    }
  }
  if (changed) {
    mkdirSync(CONFIG_FILE.slice(0, Math.max(CONFIG_FILE.lastIndexOf('/'), CONFIG_FILE.lastIndexOf('\\'))), { recursive: true })
    writeFileSync(SECRETS_FILE, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(SECRETS_FILE, 0o600)
    } catch {
      // best effort: Windows ACLs do not map onto POSIX modes
    }
    secretsState = { mtime: statSync(SECRETS_FILE).mtimeMs, value: current }
    // A token change invalidates every cached remote response.
    remoteCache.clear()
    cache = { key: '', at: 0, model: null }
  }
  return { github: tokenFor('github') !== '', gitee: tokenFor('gitee') !== '' }
}

/**
 * Merge a patch into the stored config and write it back.
 * @param patch - partial config fields.
 * @returns the saved config.
 */
function saveConfig(patch) {
  const current = effectiveConfig().value
  const clean = sanitizePatch(patch)
  const merged = normalizeConfig({
    ...current,
    ...clean,
    identity: { ...current.identity, ...(clean.identity ?? {}) },
    // remotes is two levels deep: merge per provider so patching only
    // `github` never wipes a configured `gitee` login.
    remotes: {
      github: { ...current.remotes.github, ...(clean.remotes?.github ?? {}) },
      gitee: { ...current.remotes.gitee, ...(clean.remotes?.gitee ?? {}) },
    },
  })
  mkdirSync(CONFIG_FILE.slice(0, Math.max(CONFIG_FILE.lastIndexOf('/'), CONFIG_FILE.lastIndexOf('\\'))), { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  configState = { mtime: statSync(CONFIG_FILE).mtimeMs, value: merged, file: CONFIG_FILE }
  cache = { key: '', at: 0, model: null }
  return merged
}

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

// ------------------------------------------------------------------- remotes

/** Dynamic import so a missing or broken adapter degrades instead of failing boot. */
let remoteAdapter = null
let remoteAdapterMissing = false
/** mtime of the adapter file the cached module came from. */
let remoteAdapterMtime = -1

/** Resolve the adapter file path from this module's own URL. */
const REMOTE_ADAPTER_PATH = fileURLToPath(new URL('./remotes.js', import.meta.url))
const REMOTE_ADAPTER_URL = pathToFileURL(REMOTE_ADAPTER_PATH)

/**
 * Load the remote adapter, reloading it when the file changes.
 *
 * A plain `import('./remotes.js')` is cached by URL for the life of the
 * process, which would force a Harness restart for every adapter edit. The
 * query suffix keyed on mtime keeps the adapter hot-reloadable while the host
 * half stays untouched.
 * @returns the module, or null when it is unavailable.
 */
async function loadRemoteAdapter() {
  let mtime = 0
  try {
    mtime = statSync(REMOTE_ADAPTER_PATH).mtimeMs
  } catch {
    mtime = 0
  }
  if (mtime === 0) {
    if (!remoteAdapterMissing) ctx_log('remote adapter file is missing')
    remoteAdapterMissing = true
    remoteAdapter = null
    remoteAdapterMtime = -1
    return null
  }
  if (remoteAdapter !== null && remoteAdapterMtime === mtime) return remoteAdapter
  try {
    remoteAdapter = await import(`${REMOTE_ADAPTER_URL.href}?v=${mtime}`)
    remoteAdapterMtime = mtime
    remoteAdapterMissing = false
  } catch (error) {
    remoteAdapterMissing = true
    remoteAdapter = null
    remoteAdapterMtime = mtime
    ctx_log(`remote adapter failed to load: ${String(error)}`)
  }
  return remoteAdapter
}

/** Module-level logger shim; the adapter loader runs outside the ctx closure. */
let ctx_log = () => {}

/** Provider results are expensive (rate limits), so cache them for ten minutes. */
const remoteCache = new Map()
const REMOTE_TTL_MS = 600_000

/**
 * Fetch one provider's contributions for a date range.
 * @param cfg - the live config.
 * @param provider - 'github' | 'gitee'.
 * @param from - inclusive `YYYY-MM-DD`.
 * @param to - inclusive `YYYY-MM-DD`.
 * @param force - bypass the cache.
 * @returns the adapter result plus the provider name.
 */
async function remoteDaysFor(cfg, provider, from, to, force) {
  const entry = cfg.remotes[provider] ?? { login: '', enabled: false }
  if (entry.enabled !== true || entry.login === '') {
    return { provider, ok: false, error: { code: 'not-configured', message: `未配置 ${provider} 用户名` } }
  }
  const token = tokenFor(provider)
  const key = `${provider}|${entry.login}|${from}|${to}|${token === '' ? 'anon' : 'auth'}`
  const hit = remoteCache.get(key)
  if (!force && hit !== undefined && Date.now() - hit.at < REMOTE_TTL_MS) {
    return { ...hit.value, provider, cached: true }
  }
  const adapter = await loadRemoteAdapter()
  if (adapter === null) {
    return { provider, ok: false, error: { code: 'adapter-missing', message: '远程适配器不可用' } }
  }
  let result
  try {
    result = await adapter.fetchRemoteContributions({
      provider,
      login: entry.login,
      token,
      proxyUrl: cfg.proxyUrl,
      from,
      to,
      timeoutMs: 15_000,
    })
  } catch (error) {
    result = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
  }
  remoteCache.set(key, { at: Date.now(), value: result })
  return { ...result, provider, cached: false }
}

/** Per-day commit lookups are one API call each, so they get their own cache. */
const dayCache = new Map()
const DAY_TTL_MS = 600_000

/** Only a plain calendar date is accepted here; anything else is a bad request. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * A shape check alone accepts `2026-13-99`, so the value is also round-tripped
 * through a UTC date: month 13 rolls over and fails the comparison.
 * @param text - the candidate date.
 * @returns true when it is a real calendar day.
 */
function isValidDay(text) {
  if (typeof text !== 'string' || !DAY_PATTERN.test(text)) return false
  const [year, month, day] = text.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/**
 * Fetch the concrete commits behind one day's remote contributions.
 *
 * The count and the list are two different numbers and must not be conflated:
 * GitHub's contribution calendar counts PRs, issues and reviews as well, so a
 * day can show contributions while its commit search returns nothing. The
 * adapter reports what it actually found and the caller passes the caveat on.
 * @param cfg - the live config.
 * @param date - `YYYY-MM-DD`.
 * @param force - bypass the cache.
 * @returns merged commits plus a per-provider status list.
 */
async function dayCommitsFor(cfg, date, force) {
  const providers = ['github', 'gitee'].filter((provider) => cfg.remotes[provider]?.enabled === true)
  if (providers.length === 0) {
    return { date, commits: [], providers: [], notes: ['没有启用任何远程来源。'] }
  }
  const adapter = await loadRemoteAdapter()
  if (adapter === null) {
    return { date, commits: [], providers: [], notes: ['远程适配器不可用（lib/remotes.js 未加载）。'] }
  }
  const statuses = []
  const commits = []
  const seen = new Set()
  for (const provider of providers) {
    const entry = cfg.remotes[provider]
    const token = tokenFor(provider)
    const key = `${provider}|${entry.login}|${date}|${token === '' ? 'anon' : 'auth'}`
    const hit = dayCache.get(key)
    let result
    if (!force && hit !== undefined && Date.now() - hit.at < DAY_TTL_MS) {
      result = hit.value
    } else {
      try {
        result = await adapter.fetchDayCommits({
          provider,
          login: entry.login,
          token,
          date,
          // The adapter re-buckets the commits it found into this zone, so the
          // list matches the cell the user clicked rather than GitHub's UTC day.
          timeZone: cfg.timezone,
          proxyUrl: cfg.proxyUrl,
          timeoutMs: 15_000,
        })
      } catch (error) {
        result = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
      }
      dayCache.set(key, { at: Date.now(), value: result })
    }
    if (result.ok !== true) {
      statuses.push({ provider, ok: false, count: 0, truncated: false, warnings: [], error: result.error ?? { code: 'internal', message: '未知错误' } })
      continue
    }
    statuses.push({
      provider,
      ok: true,
      count: result.commits.length,
      truncated: result.truncated === true,
      warnings: result.warnings ?? [],
      error: null,
    })
    for (const commit of result.commits) {
      const dedupeKey = `${commit.source}|${commit.sha}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      commits.push(commit)
    }
  }
  commits.sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
  return {
    date,
    commits,
    providers: statuses,
    notes: [
      'GitHub 的贡献数包含 PR / Issue / 评审，所以这里查到的提交可能少于格子上的数字。',
    ],
  }
}

/**
 * Fold remote days into the local model. `count` becomes local + remote so the
 * same grid shows everything the user actually did; `local` and `remote` keep
 * the breakdown for the tooltip. Remote-only days are appended.
 * @param model - the freshly built local model (mutated).
 * @param results - adapter results.
 * @param range - the window the model covers.
 * @returns the model plus a per-provider status list.
 */
function mergeRemoteDays(model, results, range) {
  const byDate = new Map()
  const totals = { github: 0, gitee: 0 }
  for (const result of results) {
    if (result.ok !== true || !Array.isArray(result.days)) continue
    for (const day of result.days) {
      if (typeof day?.date !== 'string' || day.date < range.from || day.date > range.to) continue
      const counts = byDate.get(day.date) ?? {}
      counts[result.provider] = (counts[result.provider] ?? 0) + (Number(day.count) || 0)
      totals[result.provider] += Number(day.count) || 0
      byDate.set(day.date, counts)
    }
  }

  const daysByKey = new Map(model.days.map((day) => [day.date, day]))
  for (const [date, counts] of byDate) {
    let day = daysByKey.get(date)
    if (day === undefined) {
      day = { date, count: 0, level: 0, repos: {} }
      model.days.push(day)
      daysByKey.set(date, day)
    }
    const remoteSum = Object.values(counts).reduce((sum, value) => sum + value, 0)
    day.local = day.count
    day.remote = counts
    day.count = day.count + remoteSum
  }
  model.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  model.stats.remote = totals
  model.remoteStatus = results.map((result) => ({
    provider: result.provider,
    ok: result.ok === true,
    source: result.ok === true ? result.source : null,
    days: result.ok === true && Array.isArray(result.days) ? result.days.length : 0,
    cached: result.cached === true,
    warnings: result.ok === true ? (result.warnings ?? []) : [],
    error: result.ok === true ? null : result.error,
  }))
  return model
}

// --------------------------------------------------------------- model build

/** Formatters are expensive to construct, so cache one per configured timezone. */
const formatterCache = new Map()

/**
 * The day formatter for one timezone.
 * @param timeZone - IANA zone name.
 * @returns the cached formatter.
 */
function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Resolve an epoch second to its `YYYY-MM-DD` day in the configured timezone.
 *
 * Never derive this from an ISO string's own offset: 1048 commits on this
 * machine end with `Z`, and slicing the offset yields NaN.
 * @param timeZone - IANA zone name.
 * @param at - epoch seconds.
 * @returns the day key.
 */
const dayOfIn = (timeZone, at) => formatterFor(timeZone).format(new Date(at * 1000))

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
async function buildModel(ctx, cfg) {
  const startedAt = Date.now()
  const discovery = await discoverRepos(cfg.roots, { maxDepth: cfg.maxDepth })
  const checkouts = discovery.found.filter((repo) => repo.gitKind === 'dir')
  const skippedNonDir = discovery.found.filter((repo) => repo.gitKind !== 'dir').map((repo) => repo.workdir)

  const aliases = new Set(cfg.identity.aliases.map((email) => email.toLowerCase()))
  const logs = await mapLimit(checkouts, cfg.concurrency, (repo) => readRepoLog(ctx, repo))

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
    row.day = dayOfIn(cfg.timezone, row.at)
    const bucket = dayMap.get(row.day) ?? { date: row.day, count: 0, repos: {} }
    bucket.count += 1
    bucket.repos[row.repoId] = (bucket.repos[row.repoId] ?? 0) + 1
    dayMap.set(row.day, bucket)
  }

  const allDays = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  // The grid only draws the rolling window, so every day-level number the page
  // shows (totals, busiest day, streak, level thresholds) is computed inside
  // that window — otherwise "总提交 689" would not match what a reader can
  // count in the 371 cells. All-time counters stay available under allTime.
  const range = windowOf(new Date(), cfg.weeks)
  const days = allDays.filter((day) => day.date >= range.from && day.date <= range.to)
  const windowCommits = commits.filter((row) => row.day >= range.from && row.day <= range.to)

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
    commitCountMine: windowCommits.length,
    crossRepoDuplicates,
    dayCount: days.length,
    maxPerDay: busiest === null ? 0 : busiest.count,
    longestStreak: longestStreak(days.map((day) => day.date)),
    busiest: busiest === null ? null : { date: busiest.date, count: busiest.count },
    levelThresholds: thresholds,
    allTime: {
      commitCountMine: commits.length,
      dayCount: allDays.length,
      firstCommitAt: commits.reduce((best, row) => (best === null || row.at < best ? row.at : best), null),
      lastCommitAt: commits.reduce((best, row) => (best === null || row.at > best ? row.at : best), null),
    },
  }

  return {
    model: {
      schemaVersion: 1,
      stage: 'M2',
      generatedAt: new Date().toISOString(),
      timezone: cfg.timezone,
      weeks: cfg.weeks,
      range,
      stats,
      /**
       * Which prerequisites are still missing. The page turns these into a
       * "go configure this" banner instead of presenting an empty grid as if
       * the machine simply had no commits.
       */
      setup: {
        roots: cfg.roots.length === 0,
        identity: cfg.identity.aliases.length === 0,
      },
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
      commits: windowCommits.map((row) => ({
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
      roots: cfg.roots,
      concurrency: cfg.concurrency,
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
    /**
     * The live config. Re-read on every call so an edit on disk — or a save
     * through `/git-heat/config/save` — applies to the next request without
     * remounting the row. Fields the profile patch declares still win.
     * @returns the normalized config.
     */
    const cfgOf = () => {
      const live = effectiveConfig().value
      const patched = config !== null && typeof config === 'object' ? config : {}
      return normalizeConfig({ ...live, ...patched, identity: { ...live.identity, ...(patched.identity ?? {}) } })
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

    /** The live config view the page can introspect (and the settings surface reads). */
    const configView = () => {
      const cfg = cfgOf()
      return {
        stage: 'M3',
        ...cfg,
        // Tokens never appear here — only whether one was found in the env.
        tokenEnv: { github: TOKEN_ENV.github, gitee: TOKEN_ENV.gitee },
        tokenSet: { github: tokenFor('github') !== '', gitee: tokenFor('gitee') !== '' },
        source: effectiveConfig().file === null ? 'defaults' : 'file',
        configPath: CONFIG_FILE,
        cacheTtlMs: cfg.ttlSeconds * 1000,
        dataLayer: 'wired',
      }
    }

    /**
     * The model, served from cache unless stale or a refresh was asked for.
     * A cold build re-runs every repository's log (~1.5 s across 34 checkouts
     * at 6-way concurrency); the cache is what keeps the page snappy.
     * @param force - bypass the cache.
     * @returns the model view.
     */
    const heat = async (force) => {
      const cfg = cfgOf()
      // The key covers every input that changes the result, so editing the
      // config (or the profile patch) can never serve a stale model.
      const key = JSON.stringify({
        roots: cfg.roots,
        aliases: cfg.identity.aliases,
        timezone: cfg.timezone,
        weeks: cfg.weeks,
        maxDepth: cfg.maxDepth,
        remotes: cfg.remotes,
        proxyUrl: cfg.proxyUrl,
      })
      const fresh = cache.model !== null && cache.key === key && Date.now() - cache.at < cfg.ttlSeconds * 1000
      if (fresh && !force) return { ...cache.model, cached: true, elapsedMs: Date.now() - cache.at }
      const built = await buildModel(ctx, cfg)
      const model = built.model

      // Remote sources are optional and never block the local result: a
      // provider that is unconfigured, rate-limited or offline becomes one
      // entry in remoteStatus instead of an error for the whole page.
      const providers = ['github', 'gitee'].filter((provider) => cfg.remotes[provider]?.enabled === true)
      if (providers.length > 0) {
        const results = await Promise.all(
          providers.map((provider) => remoteDaysFor(cfg, provider, model.range.from, model.range.to, force)),
        )
        mergeRemoteDays(model, results, model.range)
      } else {
        model.remoteStatus = []
        model.stats.remote = { github: 0, gitee: 0 }
      }

      cache = { key, at: Date.now(), model }
      return { ...model, cached: false, elapsedMs: built.diagnostics.elapsedMs, diagnostics: built.diagnostics }
    }

    /** Route the adapter loader's diagnostics into the host logger. */
    ctx_log = (message) => ctx.logger?.warn?.(`dsh-git-heatmap: ${message}`)

    /**
     * Probe both remote providers so the page can show 未配置 / 令牌无效 / 可用
     * without running a full heat build.
     * @param force - bypass the probe cache.
     * @returns one status row per provider.
     */
    const remoteStatus = async (force) => {
      const cfg = cfgOf()
      const adapter = await loadRemoteAdapter()
      const providers = ['github', 'gitee']
      const rows = await Promise.all(providers.map(async (provider) => {
        const entry = cfg.remotes[provider] ?? { login: '', enabled: false }
        const token = tokenFor(provider)
        const base = { provider, login: entry.login, enabled: entry.enabled === true, tokenSet: token !== '' }
        if (entry.login === '') return { ...base, ok: false, error: { code: 'not-configured', message: '未配置用户名' } }
        if (adapter === null) return { ...base, ok: false, error: { code: 'adapter-missing', message: '远程适配器不可用' } }
        try {
          const result = await adapter.probeRemote({
            provider,
            login: entry.login,
            token,
            proxyUrl: cfg.proxyUrl,
            timeoutMs: 12_000,
            force,
          })
          return { ...base, ...result }
        } catch (error) {
          return { ...base, ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
        }
      }))
      return { providers: rows, proxyUrl: cfg.proxyUrl, adapterReady: adapter !== null }
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
        if (pathname === `${PREFIX}/config/save`) {
          // Loopback + POST + JSON content-type already enforced above; the
          // patch is normalized field by field, so a bad value cannot corrupt
          // the rest of the stored config. `secrets` is split out: tokens go to
          // the secrets file and are never echoed back.
          const saved = saveConfig(body)
          const tokenSet = writeSecrets(body.secrets)
          writeJson(response, 200, ok({
            saved: true,
            config: saved,
            tokenSet,
            configPath: CONFIG_FILE,
            secretsPath: SECRETS_FILE,
          }))
          return
        }
        if (pathname === `${PREFIX}/probe`) {
          writeJson(response, 200, ok(await probe()))
          return
        }
        if (pathname === `${PREFIX}/remote`) {
          writeJson(response, 200, ok(await remoteStatus(body.refresh === true)))
          return
        }
        if (pathname === `${PREFIX}/day`) {
          const date = typeof body.date === 'string' ? body.date.trim() : ''
          if (!isValidDay(date)) {
            writeJson(response, 200, fail('bad-request', 'date 必须是真实的 YYYY-MM-DD 日期。'))
            return
          }
          writeJson(response, 200, ok(await dayCommitsFor(cfgOf(), date, body.refresh === true)))
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
