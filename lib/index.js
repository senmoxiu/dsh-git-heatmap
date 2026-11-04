/**
 * @senmoxiu/dsh-git-heatmap — host half.
 *
 * Runs in the DSH host process: owns the `/git-heat/*` routes and every git
 * subprocess the heatmap needs. The browser half (exports "./client") never
 * touches git; it asks these routes for facts.
 *
 * Stage: M0 + M1. `/git-heat/probe` is the load-bearing one — it is the
 * experiment that proves the host process may spawn git at all. Everything
 * else (repository discovery, per-author aggregation) lands in M2 on top of
 * the same runner.
 *
 * No build step and no runtime dependencies on purpose: this file is the
 * shipped artifact. Only `node:` builtins are imported.
 * @module @senmoxiu/dsh-git-heatmap
 */

/** Route prefix. Must not collide with git-graph's `/git` (prefix) + `/git/events` (exact). */
const PREFIX = '/git-heat'

/** Collected-output cap for one git command. */
const OUTPUT_CAP_BYTES = 1 << 20

/**
 * Locale every git child runs under. Pinning to C keeps git's own messages the
 * English strings our error classification will be written against, on a zh_CN
 * host too. Deliberate exception to the ambient environment, not a general
 * locale policy: it only ever covers git children.
 */
const GIT_CHILD_ENV = { LC_ALL: 'C', LANG: 'C' }

/** Probe deadline; the abort reaches the subprocess tree. */
const PROBE_TIMEOUT_MS = 8_000

/**
 * Spawn argv for git. On win32 the executable must be `git.exe`: the `.cmd`
 * shim cannot be launched by a shell-less spawn, and going through cmd.exe
 * would expand the `%` in `--format=%H`.
 * @param args - git arguments after the executable.
 * @returns the full argv handed to the subprocess service.
 */
const gitArgv = (args) => (process.platform === 'win32' ? ['git.exe', ...args] : ['git', ...args])

/** Default scan roots; M2 turns this into a real config field. */
const DEFAULT_ROOTS = ['D:/项目', 'D:/笔记']

/** The identity set the heatmap counts. See research/02-git-data.md §5.1. */
const IDENTITY = {
  primaryEmail: '2801251352@qq.com',
  aliases: ['2801251352@qq.com'],
  names: ['森修', 'senxiu'],
}

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
 * The subprocess surface this module consumes (structural, so the module stays
 * free of a cordis import; the host context satisfies it).
 * @typedef {object} SubprocessServiceLike
 * @property {(spec: object) => object} spawn
 */

/**
 * Run one git command through the managed subprocess service.
 * @param ctx - context carrying `subprocess`.
 * @param args - git arguments after the executable.
 * @param cwd - working directory.
 * @param timeoutMs - abort deadline.
 * @returns exit code plus both streams.
 */
async function runGit(ctx, args, cwd, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const spec = {
      argv: gitArgv(args),
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: OUTPUT_CAP_BYTES },
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

/** Required services: the route registry and the managed subprocess seam. */
export const inject = ['webServer', 'subprocess']

/**
 * Mount the routes. Everything registered here is released by the returned
 * disposer, so a profile reload never double-registers `/git-heat`.
 * @param ctx - context carrying `webServer` and `subprocess`.
 * @param config - the row's config (unused in M1; M2 reads roots/identity).
 */
export function apply(ctx, config) {
  ctx.effect(() => {
    /**
     * M0: the load-bearing experiment — can the host process spawn git?
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

    /** The static half of the plugin config the page shows before M2 lands. */
    const configView = () => ({
      stage: 'M1',
      roots: config?.roots ?? DEFAULT_ROOTS,
      identity: IDENTITY,
      timezone: 'Asia/Shanghai',
      weeks: 53,
      dataLayer: 'not-wired',
    })

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
      if (pathname === `${PREFIX}/config`) {
        writeJson(response, 200, ok(configView()))
        return
      }
      if (pathname === `${PREFIX}/probe`) {
        try {
          writeJson(response, 200, ok(await probe()))
        } catch (error) {
          writeJson(response, 500, fail('internal', error instanceof Error ? error.message : String(error)))
        }
        return
      }
      writeJson(response, 404, fail('not-found', `unknown route: ${pathname}`))
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
