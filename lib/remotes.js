/**
 * @senmoxiu/dsh-git-heatmap — remote contribution adapters.
 *
 * Pulls a user's per-day commit contribution counts from GitHub / Gitee so the
 * heatmap can merge remote work next to the locally counted commits. This file
 * is self-contained on purpose: only `node:` builtins, no third-party HTTP or
 * proxy library, no build step.
 *
 * What was actually measured on this machine (2026-11-05, Shanghai):
 *
 *   GitHub, no token, direct:
 *     GET https://api.github.com/users/torvalds                      -> 200, ~800 ms
 *     GET https://api.github.com/users/torvalds/events/public        -> 200, 100 events
 *   GitHub, no token, through http://127.0.0.1:7897 (CONNECT tunnel):
 *     CONNECT api.github.com:443                                     -> 200 in 7 ms
 *     GET /users/torvalds over that tunnel                           -> 403 (see below)
 *   Gitee, no token, direct:
 *     GET https://gitee.com/api/v5/users/Torvalds                    -> 200, ~315 ms
 *     GET https://gitee.com/api/v5/users/ruoyi/events                -> 200, `[]` (needs a token)
 *     GET https://gitee.com/api/v5/users/ruoyi/events/public         -> 200, real events
 *
 * Three findings drive the shape of this module:
 *
 * 1. GitHub's public event stream no longer carries commit counts. Every one of
 *    the 100 PushEvents sampled had the payload shape
 *    `{before, head, push_id, ref, repository_id}` — no `size`, no `distinct_size`,
 *    no `commits[]`. So the anonymous fallback can only count pushes, not commits,
 *    and it says so in `warnings`. Do not "fix" this by reading `payload.size`:
 *    it is always `undefined` now.
 * 2. Gitee's `PushEvent.payload.size` IS the commit count. Verified on 243 push
 *    events across 7 accounts: `size === commits.length` in 243/243 cases.
 * 3. Gitee's event endpoint ignores `page` but honours `limit` (verified:
 *    `?limit=100&page=2` returns the same 100 rows as `?limit=100`), so the
 *    anonymous Gitee path can only ever see the newest ~100 events.
 *
 * Day bucketing is Asia/Shanghai via `Intl`, never `toISOString().slice(0,10)`:
 * `2026-11-01T17:55:38Z` is `2026-11-02` in Shanghai but `2026-11-01` in UTC.
 *
 * @module @senmoxiu/dsh-git-heatmap/remotes
 */

import { connect as netConnect } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { gunzipSync } from 'node:zlib'

/** Hard ceiling for one end-to-end call, including the proxy tunnel. */
const DEFAULT_TIMEOUT_MS = 15000

/** Response bodies above this are refused rather than buffered. */
const MAX_BODY_BYTES = 8 << 20

/** GitHub rejects requests without a User-Agent. */
const USER_AGENT = 'dsh-git-heatmap-remotes/0.1'

/** `Intl` formats `en-CA` as `YYYY-MM-DD`, which is the key the heatmap wants. */
const SHANGHAI_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Cache one formatter per timezone (construction is the expensive part). */
const ZONE_FORMATTERS = new Map()

/**
 * Format an epoch-second instant as a `YYYY-MM-DD` key in one timezone.
 * @param {number} at - epoch seconds.
 * @param {string} timeZone - IANA zone.
 * @returns {string} the day key.
 */
function dayInZone(at, timeZone) {
  let formatter = ZONE_FORMATTERS.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    ZONE_FORMATTERS.set(timeZone, formatter)
  }
  return formatter.format(new Date(at * 1000))
}

/**
 * Shift a `YYYY-MM-DD` key by whole days (UTC arithmetic, no DST surprises).
 * @param {string} date - the day key.
 * @param {number} days - offset to add.
 * @returns {string} the shifted day key.
 */
function shiftDay(date, days) {
  const [year, month, day] = date.split('-').map(Number)
  const stamp = Date.UTC(year, month - 1, day) + days * 86400000
 return new Date(stamp).toISOString().slice(0, 10)
}

/** GitHub's anonymous event stream pages at 100; 3 pages is the ~300-event cap. */
const GITHUB_EVENT_PAGES = 3

/** Gitee caps an events response at 100 and `page` has no effect. */
const GITEE_EVENT_LIMIT = 100

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql'
const GITHUB_API = 'https://api.github.com'
const GITEE_API = 'https://gitee.com/api/v5'

/** Warnings that describe a structurally limited source, not a failed request. */
const WARN_GITHUB_NO_TOKEN =
  '未携带令牌：GitHub 只提供公开事件流（最近约 90 天、最多 300 条），不含私有仓库贡献。'
const WARN_GITHUB_PUSH_ONLY =
  'GitHub 事件流的 PushEvent 已不再携带提交数量字段（实测 payload 仅有 before/head/push_id/ref/repository_id），所以每个 push 记 1；这里的数字是推送次数，不是精确提交数。'
const WARN_GITEE_NO_TOKEN =
  '未携带令牌：Gitee 公开事件单次最多返回最近 100 条且不支持翻页，更早日期可能缺失。'

/* -------------------------------------------------------------------------- */
/* errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Structured failure. Every public entry point resolves one of these instead of
 * throwing, so a caller in the host process never has to wrap us in try/catch.
 * @param {string} code short kebab-case code, e.g. `auth-failed`
 * @param {string} message human-readable, Chinese
 * @returns {{ok:false, error:{code:string, message:string}}}
 */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/** A failure that must travel as a thrown exception until the boundary catches it. */
class CallError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Map an HTTP status plus response text onto a stable error code.
 * 403 is ambiguous on both providers: GitHub and Gitee both use it for a spent
 * anonymous quota, so the body decides between `rate-limited` and `auth-failed`.
 * @param {number} status
 * @param {string} body raw response text (may be empty or non-JSON)
 * @param {string} provider `github` | `gitee`
 * @returns {{ok:false, error:{code:string, message:string}}}
 */
function classifyStatus(status, body, provider) {
  const lower = String(body || '').toLowerCase()
  const rateLimited = lower.includes('rate limit') || lower.includes('rate_limit')

  if (status === 401) {
    return fail('auth-failed', `${provider} 拒绝了该令牌（HTTP 401）。`)
  }
  if (status === 403) {
    if (rateLimited) {
      return fail(
        'rate-limited',
        `${provider} 匿名配额已用完（HTTP 403）。配置令牌可获得更高配额；也可以稍后重试。`,
      )
    }
    return fail('auth-failed', `${provider} 拒绝访问（HTTP 403），令牌可能缺少所需权限。`)
  }
  if (status === 429) {
    return fail('rate-limited', `${provider} 触发限流（HTTP 429），请稍后重试。`)
  }
  if (status === 404) {
    return fail('not-found', `${provider} 上找不到该用户（HTTP 404）。`)
  }
  return fail('http-status', `${provider} 返回了 HTTP ${status}。`)
}

/* -------------------------------------------------------------------------- */
/* dates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Convert any timestamp the providers hand back into a Shanghai calendar day.
 * Gitee emits offsets (`2026-06-12T14:31:20+08:00`), GitHub emits UTC (`...Z`);
 * both go through `Date` and then `Intl`, so the offset is honoured either way.
 * @param {unknown} value raw timestamp
 * @returns {string|null} `YYYY-MM-DD`, or null when unparseable
 */
function shanghaiDay(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return null
  return SHANGHAI_DATE.format(d)
}

/**
 * Strictly validate a `YYYY-MM-DD` string, rejecting rolled-over dates such as
 * `2026-02-30`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(d.getTime())) return false
  return d.toISOString().slice(0, 10) === value
}

/**
 * GraphQL wants an ISO 8601 instant, not a bare date; anchor on Shanghai midnight
 * so the contribution window matches the calendar the heatmap draws.
 * @param {string} day `YYYY-MM-DD`
 * @param {'start'|'end'} edge
 * @returns {string}
 */
function graphqlInstant(day, edge) {
  return edge === 'start' ? `${day}T00:00:00+08:00` : `${day}T23:59:59+08:00`
}

/** @param {string} day @param {string} from @param {string} to @returns {boolean} */
function inRange(day, from, to) {
  return day >= from && day <= to
}

/* -------------------------------------------------------------------------- */
/* transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Open a `CONNECT` tunnel through an HTTP proxy. Verified working against
 * `127.0.0.1:7897` (the probe returns `HTTP/1.1 200 Connection established` in ~7 ms).
 * Basic proxy credentials are taken from the proxy URL when present.
 * @param {string} proxyUrl e.g. `http://127.0.0.1:7897`
 * @param {string} host target host
 * @param {number} port target port
 * @param {number} timeoutMs
 * @returns {Promise<import('node:net').Socket>}
 */
function openProxyTunnel(proxyUrl, host, port, timeoutMs) {
  let proxy
  try {
    proxy = new URL(proxyUrl)
  } catch {
    throw new CallError('invalid-argument', `proxyUrl 不是合法 URL：${proxyUrl}`)
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new CallError('invalid-argument', `proxyUrl 只支持 http/https，收到 ${proxy.protocol}`)
  }

  const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
  const auth =
    proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString('base64')}\r\n`
      : ''

  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(arg)
    }
    const socket = netConnect({ host: proxy.hostname, port: proxyPort })
    const timer = setTimeout(() => {
      socket.destroy()
      done(reject, new CallError('timeout', `连接代理 ${proxy.hostname}:${proxyPort} 超时。`))
    }, timeoutMs)

    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      // Headers end at the first blank line; the tunnel body (if any) stays in
      // the socket untouched because we stop listening right here.
      if (!buffer.includes('\r\n\r\n')) return
      socket.removeListener('data', onData)
      const statusLine = buffer.split('\r\n')[0]
      if (/^HTTP\/1\.[01] 200\b/i.test(statusLine)) {
        socket.setTimeout(0)
        done(resolve, socket)
      } else {
        socket.destroy()
        done(
          reject,
          new CallError('network', `代理 CONNECT ${host}:${port} 失败：${statusLine || '(空响应)'}`),
        )
      }
    }

    socket.on('data', onData)
    socket.on('error', (e) =>
      done(reject, new CallError('network', `连不上代理 ${proxy.hostname}:${proxyPort}（${e.code || e.message}）。`)),
    )
    socket.write(
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`,
      'latin1',
    )
  })
}

/**
 * One HTTPS request, optionally over a proxy tunnel. Resolves a plain result
 * object; transport failures throw `CallError` and are converted at the edge.
 * @param {string} targetUrl absolute https URL
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string|null} [options.body] already-serialised body
 * @param {string|null} [options.proxyUrl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{status:number, headers:Record<string,string|string[]|undefined>, text:string, ms:number}>}
 */
async function httpsCall(targetUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    proxyUrl = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const url = new URL(targetUrl)
  if (url.protocol !== 'https:') {
    throw new CallError('invalid-argument', `只支持 https 目标，收到 ${url.protocol}`)
  }
  const host = url.hostname
  const port = Number(url.port || 443)
  const started = Date.now()

  const tunnel = proxyUrl ? await openProxyTunnel(proxyUrl, host, port, timeoutMs) : null

  const requestHeaders = {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': USER_AGENT,
    ...headers,
  }
  if (body != null) {
    requestHeaders['content-length'] = String(Buffer.byteLength(body))
  }

  const requestOptions = {
    method,
    host,
    port,
    path: `${url.pathname}${url.search}`,
    headers: requestHeaders,
  }
  if (tunnel) {
    // Hand the already-established TLS-over-tunnel stream to node:https; the
    // servername keeps SNI and certificate verification pointed at the target.
    requestOptions.createConnection = () => tlsConnect({ socket: tunnel, servername: host })
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(arg)
    }

    const req = httpsRequest(requestOptions, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          req.destroy()
          done(reject, new CallError('bad-response', '响应体超过 8 MiB 上限，已中止。'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let raw = Buffer.concat(chunks)
        try {
          if (String(res.headers['content-encoding'] || '').includes('gzip')) {
            raw = gunzipSync(raw)
          }
        } catch {
          done(reject, new CallError('bad-response', '响应体声明为 gzip 但无法解压。'))
          return
        }
        done(resolve, {
          status: res.statusCode || 0,
          headers: res.headers,
          text: raw.toString('utf8'),
          ms: Date.now() - started,
        })
      })
      res.on('error', (e) => done(reject, new CallError('network', `读取响应失败：${e.message}`)))
    })

    // A whole-call deadline, not a socket-idle timer: a slow-drip response must
    // still end, otherwise the plugin route hangs the host.
    const timer = setTimeout(() => {
      req.destroy()
      done(reject, new CallError('timeout', `请求 ${host} 超过 ${timeoutMs} ms。`))
    }, timeoutMs)

    req.on('error', (e) =>
      done(reject, new CallError('network', `请求 ${host} 失败：${e.code || e.message}`)),
    )
    if (body != null) req.write(body)
    req.end()
  })
}

/**
 * Parse a JSON body, converting the provider's HTML error pages (Gitee returns
 * plain text on 403) into `bad-response` instead of a `SyntaxError`.
 * @param {string} text
 * @param {string} provider
 * @returns {unknown}
 */
function parseJson(text, provider) {
  try {
    return JSON.parse(text)
  } catch {
    const preview = String(text || '').trim().slice(0, 120) || '(空响应)'
    throw new CallError('bad-response', `${provider} 返回的不是 JSON：${preview}`)
  }
}

/**
 * Guard for a response whose status is not 2xx.
 * @param {{status:number, text:string}} response
 * @param {string} provider
 */
function assertOk(response, provider) {
  if (response.status < 200 || response.status >= 300) {
    const mapped = classifyStatus(response.status, response.text, provider)
    throw new CallError(mapped.error.code, mapped.error.message)
  }
}

/* -------------------------------------------------------------------------- */
/* aggregation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Accumulate `count` into `map[day]`, skipping days outside `[from, to]` and
 * timestamps that cannot be parsed.
 * @param {Map<string, number>} map
 * @param {unknown} timestamp
 * @param {number} count
 * @param {string} from
 * @param {string} to
 * @returns {boolean} whether the timestamp fell inside the range
 */
function addDay(map, timestamp, count, from, to) {
  const day = shanghaiDay(timestamp)
  if (!day || !inRange(day, from, to)) return false
  if (!Number.isFinite(count) || count <= 0) return false
  map.set(day, (map.get(day) || 0) + count)
  return true
}

/**
 * Sparse `{date, count}` list sorted oldest-first. Days with zero contributions
 * are omitted: the caller merges remote days into a locally built grid, and an
 * explicit `0` would erase local work on the same day.
 * @param {Map<string, number>} map
 * @returns {Array<{date:string, count:number}>}
 */
function toDays(map) {
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, count]) => ({ date, count }))
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                     */
/* -------------------------------------------------------------------------- */

/** The only endpoint that yields an exact contribution calendar. */
const GITHUB_CONTRIBUTIONS_QUERY = `query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`

/**
 * GitHub caps `contributionsCollection` at one year per call ("The total time
 * spanned by 'from' and 'to' must not exceed 1 year"), and the heatmap window is
 * routinely two years wide, so the range is split on year boundaries and the
 * per-day counts are summed.
 * @param {string} login
 * @param {string} token
 * @param {string} from
 * @param {string} to
 * @param {string|null} proxyUrl
 * @param {number} timeoutMs
 * @returns {Promise<object>} the envelope with `source: 'graphql'`.
 */
async function githubGraphql(login, token, from, to, proxyUrl, timeoutMs) {
  const chunks = splitByYear(from, to)
  // The chunks are independent requests, so they run together: three serial
  // calls through the proxy measured 10.4 s, which is the difference between
  // "acceptable" and "I thought it hung" for a first page load.
  const parts = await Promise.all(
    chunks.map((chunk) => githubGraphqlOnce(login, token, chunk.from, chunk.to, proxyUrl, timeoutMs)),
  )
  const map = new Map()
  for (const partial of parts) {
    for (const [day, count] of partial) map.set(day, (map.get(day) || 0) + count)
  }
  const warnings = []
  if (chunks.length > 1) {
    warnings.push(
      `区间跨 ${chunks.length} 年，已分 ${chunks.length} 次请求 GitHub（contributionsCollection 单次上限 1 年），结果已合并。`,
    )
  }
  return { ok: true, days: toDays(map), source: 'graphql', warnings }
}

/**
 * Split an inclusive date range on year boundaries so every piece spans at
 * most one calendar year.
 * @param {string} from - YYYY-MM-DD
 * @param {string} to - YYYY-MM-DD
 * @returns {Array<{from: string, to: string}>}
 */
function splitByYear(from, to) {
  const chunks = []
  let start = from
  while (start <= to) {
    const year = Number(start.slice(0, 4))
    const yearEnd = `${year}-12-31`
    const end = yearEnd < to ? yearEnd : to
    chunks.push({ from: start, to: end })
    if (end === to) break
    start = `${year + 1}-01-01`
  }
  return chunks.length > 0 ? chunks : [{ from, to }]
}

/**
 * Exact path: GraphQL `contributionsCollection` returns the calendar GitHub
 * itself draws, including private contributions when the token is allowed to
 * see them. Requires a bearer token — anonymous GraphQL is not usable here
 * (measured: HTTP 403 rate-limit page on this machine's direct IP).
 * @param {string} login
 * @param {string} token
 * @param {string} from
 * @param {string} to
 * @param {string|null} proxyUrl
 * @param {number} timeoutMs
 */
async function githubGraphqlOnce(login, token, from, to, proxyUrl, timeoutMs) {
  const body = JSON.stringify({
    query: GITHUB_CONTRIBUTIONS_QUERY,
    variables: {
      login,
      from: graphqlInstant(from, 'start'),
      to: graphqlInstant(to, 'end'),
    },
  })

  const response = await httpsCall(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body,
    proxyUrl,
    timeoutMs,
  })
  assertOk(response, 'github')

  const json = parseJson(response.text, 'github')
  if (!json || typeof json !== 'object') {
    throw new CallError('bad-response', 'GitHub GraphQL 返回了非对象 JSON。')
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const first = json.errors[0] || {}
    // A missing login comes back as a GraphQL error, not a 404.
    if (/could not resolve to a user/i.test(String(first.message || ''))) {
      throw new CallError('not-found', `GitHub 上找不到用户 ${login}。`)
    }
    throw new CallError('bad-response', `GitHub GraphQL 报错：${first.message || '未知错误'}`)
  }

  const user = json.data && json.data.user
  if (!user) throw new CallError('not-found', `GitHub 上找不到用户 ${login}。`)

  const weeks =
    (user.contributionsCollection &&
      user.contributionsCollection.contributionCalendar &&
      user.contributionsCollection.contributionCalendar.weeks) ||
    []

  const map = new Map()
  for (const week of weeks) {
    for (const day of (week && week.contributionDays) || []) {
      if (!day || typeof day.date !== 'string') continue
      // GraphQL already hands back a calendar date, so no timezone shift applies;
      // it is still checked against the range because GitHub pads the weeks.
      if (!inRange(day.date, from, to)) continue
      const count = Number(day.contributionCount)
      if (Number.isFinite(count) && count > 0) {
        map.set(day.date, (map.get(day.date) || 0) + count)
      }
    }
  }

  return map
}

/**
 * Anonymous fallback: the public event stream. Two hard limits, both surfaced in
 * `warnings` rather than hidden — the stream covers roughly the last 90 days and
 * 300 events, excludes private repositories, and (measured) no longer exposes
 * how many commits a push carried, so each push counts as 1.
 * @param {string} login
 * @param {string} from
 * @param {string} to
 * @param {string|null} proxyUrl
 * @param {number} timeoutMs
 */
async function githubRestEvents(login, from, to, proxyUrl, timeoutMs) {
  const warnings = [WARN_GITHUB_NO_TOKEN, WARN_GITHUB_PUSH_ONLY]
  const map = new Map()
  let pushes = 0
  let oldest = null
  let sawFullPage = false

  for (let page = 1; page <= GITHUB_EVENT_PAGES; page += 1) {
    const url = `${GITHUB_API}/users/${encodeURIComponent(login)}/events/public?per_page=100&page=${page}`
    const response = await httpsCall(url, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      proxyUrl,
      timeoutMs,
    })
    assertOk(response, 'github')

    const events = parseJson(response.text, 'github')
    if (!Array.isArray(events)) {
      throw new CallError('bad-response', 'GitHub 事件接口返回的不是数组。')
    }

    if (events.length < 100) sawFullPage = false
    else sawFullPage = true

    for (const event of events) {
      if (!event || event.type !== 'PushEvent') continue
      const payload = event.payload || {}
      // `size`/`commits` are gone from the public stream, but keep reading them
      // in case GitHub restores them; fall back to one push = one entry.
      const count =
        Number(payload.size) ||
        (Array.isArray(payload.commits) ? payload.commits.length : 0) ||
        1
      pushes += 1
      const day = shanghaiDay(event.created_at)
      if (day && (oldest === null || day < oldest)) oldest = day
      addDay(map, event.created_at, count, from, to)
    }

    if (events.length < 100) break
    // Stop early once the page has already reached past the requested window.
    if (oldest && oldest < from) break
  }

  if (pushes === 0) {
    warnings.push('该用户的公开事件流里没有 PushEvent（可能是空账号或只有私有活动）。')
  }
  if (sawFullPage || (oldest && oldest > from)) {
    warnings.push(
      `事件流最早已覆盖到 ${oldest || '未知'}，请求的起点 ${from} 更早的部分无法确认。`,
    )
  }

  return { ok: true, days: toDays(map), source: 'rest-events', warnings }
}

/* -------------------------------------------------------------------------- */
/* Gitee                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Gitee events. Anonymous callers reach `/users/{login}/events/public`, which
 * (measured) returns real PushEvents carrying `payload.size` = commit count.
 * `/users/{login}/events` returns `[]` without a token rather than 401, so the
 * token branch switches endpoint instead of relying on a status code.
 * @param {string} login
 * @param {string|null} token
 * @param {string} from
 * @param {string} to
 * @param {string|null} proxyUrl
 * @param {number} timeoutMs
 */
async function giteeEvents(login, token, from, to, proxyUrl, timeoutMs) {
  const warnings = []
  const params = new URLSearchParams({ limit: String(GITEE_EVENT_LIMIT) })
  let path
  if (token) {
    params.set('access_token', token)
    path = '/users/' + encodeURIComponent(login) + '/events'
  } else {
    path = '/users/' + encodeURIComponent(login) + '/events/public'
    warnings.push(WARN_GITEE_NO_TOKEN)
  }

  const url = `${GITEE_API}${path}?${params.toString()}`
  const response = await httpsCall(url, { proxyUrl, timeoutMs })
  assertOk(response, 'gitee')

  const events = parseJson(response.text, 'gitee')
  if (!Array.isArray(events)) {
    // Gitee answers 200 with an error object for some bad logins/tokens.
    const message = (events && (events.message || events.error)) || '不是数组'
    throw new CallError('bad-response', `Gitee 事件接口返回异常：${message}`)
  }

  const map = new Map()
  let pushes = 0
  for (const event of events) {
    if (!event || event.type !== 'PushEvent') continue
    pushes += 1
    const payload = event.payload || {}
    // Measured 243/243: `size` equals `commits.length`. Prefer `size` because it
    // survives any future truncation of the inline commit list.
    const count =
      Number(payload.size) ||
      (Array.isArray(payload.commits) ? payload.commits.length : 0) ||
      1
    addDay(map, event.created_at, count, from, to)
  }

  if (pushes === 0) {
    warnings.push('该用户的 Gitee 公开事件里没有 PushEvent。')
  }
  if (events.length >= GITEE_EVENT_LIMIT) {
    warnings.push(
      `Gitee 只返回了最新 ${GITEE_EVENT_LIMIT} 条事件且不支持翻页，更早日期一定缺失。`,
    )
  }

  return { ok: true, days: toDays(map), source: 'gitee-events', warnings }
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} RemoteContributionsInput
 * @property {'github'|'gitee'} provider
 * @property {string} login
 * @property {string} [token]
 * @property {string} [proxyUrl]
 * @property {string} from `YYYY-MM-DD`, inclusive
 * @property {string} to `YYYY-MM-DD`, inclusive
 * @property {number} [timeoutMs]
 */

/**
 * Fetch a user's per-day contribution counts from a remote provider.
 *
 * Never throws. Every failure path resolves `{ok:false, error:{code, message}}`
 * with a short kebab-case `code`.
 *
 * @param {RemoteContributionsInput} options
 * @returns {Promise<
 *   {ok:true, days:Array<{date:string, count:number}>, source:'graphql'|'rest-events'|'gitee-events', warnings:string[]}
 *   | {ok:false, error:{code:string, message:string}}>}
 */
export async function fetchRemoteContributions(options) {
  const input = options && typeof options === 'object' ? options : {}
  const provider = input.provider
  if (provider !== 'github' && provider !== 'gitee') {
    return fail('invalid-argument', `provider 必须是 github 或 gitee，收到 ${String(provider)}`)
  }

  const login = typeof input.login === 'string' ? input.login.trim() : ''
  if (!login) return fail('invalid-argument', 'login 不能为空。')

  const from = input.from
  const to = input.to
  if (!isDateString(from) || !isDateString(to)) {
    return fail('invalid-argument', 'from / to 必须是合法的 YYYY-MM-DD 日期。')
  }
  if (from > to) return fail('invalid-argument', `from(${from}) 不能晚于 to(${to})。`)

  const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : null
  const proxyUrl = typeof input.proxyUrl === 'string' && input.proxyUrl.trim() ? input.proxyUrl.trim() : null
  const timeoutMs =
    Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.min(input.timeoutMs, 120000)
      : DEFAULT_TIMEOUT_MS

  try {
    if (provider === 'github') {
      if (token) {
        // Exact calendar; private repositories included to the extent the token
        // is allowed to see them.
        const result = await githubGraphql(login, token, from, to, proxyUrl, timeoutMs)
        return result
      }
      return await githubRestEvents(login, from, to, proxyUrl, timeoutMs)
    }
    return await giteeEvents(login, token, from, to, proxyUrl, timeoutMs)
  } catch (error) {
    if (error instanceof CallError) return fail(error.code, error.message)
    const message = error && error.message ? error.message : String(error)
    return fail('network', `${provider} 请求失败：${message}`)
  }
}

/**
 * Cheap reachability/identity probe. The UI uses this to show
 * 「未配置 / 令牌无效 / 可用」before it asks for a whole calendar.
 *
 * @param {object} options
 * @param {'github'|'gitee'} options.provider
 * @param {string} options.login
 * @param {string} [options.token]
 * @param {string} [options.proxyUrl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<
 *   {ok:true, login:string, name?:string, avatarUrl?:string, auth:'token'|'anonymous', warnings:string[]}
 *   | {ok:false, error:{code:string, message:string}}>}
 */
export async function probeRemote(options) {
  const input = options && typeof options === 'object' ? options : {}
  const provider = input.provider
  if (provider !== 'github' && provider !== 'gitee') {
    return fail('invalid-argument', `provider 必须是 github 或 gitee，收到 ${String(provider)}`)
  }
  const login = typeof input.login === 'string' ? input.login.trim() : ''
  if (!login) return fail('invalid-argument', 'login 不能为空。')

  const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : null
  const proxyUrl = typeof input.proxyUrl === 'string' && input.proxyUrl.trim() ? input.proxyUrl.trim() : null
  const timeoutMs =
    Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.min(input.timeoutMs, 120000)
      : DEFAULT_TIMEOUT_MS

  try {
    if (provider === 'github') {
      if (token) {
        // Verified token path: GraphQL resolves the login AND proves the token.
        const body = JSON.stringify({
          query: 'query ($login: String!) { user(login: $login) { login name avatarUrl } }',
          variables: { login },
        })
        const response = await httpsCall(GITHUB_GRAPHQL_URL, {
          method: 'POST',
          headers: {
            authorization: `bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
          },
          body,
          proxyUrl,
          timeoutMs,
        })
        assertOk(response, 'github')
        const json = parseJson(response.text, 'github')
        if (Array.isArray(json.errors) && json.errors.length > 0) {
          throw new CallError('bad-response', `GitHub GraphQL 报错：${json.errors[0].message}`)
        }
        const user = json.data && json.data.user
        if (!user) throw new CallError('not-found', `GitHub 上找不到用户 ${login}。`)
        return {
          ok: true,
          login: user.login,
          name: user.name || undefined,
          avatarUrl: user.avatarUrl || undefined,
          auth: 'token',
          warnings: [],
        }
      }

      // Anonymous: the public profile endpoint is enough to prove reachability.
      const response = await httpsCall(`${GITHUB_API}/users/${encodeURIComponent(login)}`, {
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        proxyUrl,
        timeoutMs,
      })
      assertOk(response, 'github')
      const user = parseJson(response.text, 'github')
      return {
        ok: true,
        login: user.login || login,
        name: user.name || undefined,
        avatarUrl: user.avatar_url || undefined,
        auth: 'anonymous',
        warnings: [WARN_GITHUB_NO_TOKEN],
      }
    }

    // Gitee: a token only raises the rate limit / unlocks the non-public event
    // endpoint; the profile itself is public either way.
    const params = new URLSearchParams()
    if (token) params.set('access_token', token)
    const suffix = params.toString() ? `?${params.toString()}` : ''
    const response = await httpsCall(`${GITEE_API}/users/${encodeURIComponent(login)}${suffix}`, {
      proxyUrl,
      timeoutMs,
    })
    assertOk(response, 'gitee')
    const user = parseJson(response.text, 'gitee')
    if (!user || typeof user !== 'object' || !user.login) {
      throw new CallError('not-found', `Gitee 上找不到用户 ${login}。`)
    }
    const warnings = token ? [] : [WARN_GITEE_NO_TOKEN]
    return {
      ok: true,
      login: user.login,
      name: user.name || undefined,
      avatarUrl: user.avatar_url || undefined,
      auth: token ? 'token' : 'anonymous',
      warnings,
    }
  } catch (error) {
    if (error instanceof CallError) return fail(error.code, error.message)
    const message = error && error.message ? error.message : String(error)
    return fail('network', `${provider} 探针失败：${message}`)
  }
}

/* -------------------------------------------------------------------------- */
/* per-day commit details                                                     */
/* -------------------------------------------------------------------------- */

/** One page of GitHub commit search; anything beyond is reported as truncated. */
const GITHUB_COMMIT_SEARCH_PER_PAGE = 100

/** `subject` is a list row, not a body: cut it at this many characters. */
const SUBJECT_MAX_CHARS = 120

/**
 * Reduce a full commit message to a one-line list subject.
 * @param {unknown} message
 * @returns {string}
 */
function commitSubject(message) {
  if (typeof message !== 'string') return ''
  const firstLine = message.split('\n')[0].replace(/\r$/, '').trim()
  return firstLine.length > SUBJECT_MAX_CHARS ? firstLine.slice(0, SUBJECT_MAX_CHARS) : firstLine
}

/**
 * GitHub: commit search is the only endpoint that answers "which commits did
 * this author land on this day".
 *
 * Measured 2026-11-06 on this machine: a token is NOT required. The anonymous
 * call `GET /search/commits?q=author:senmoxiu+author-date:2026-11-04..2026-11-04`
 * returned **200** with `total_count: 4` on three consecutive calls, and
 * `x-ratelimit-limit: 10`. A token therefore buys a 10 → 30 req/min ceiling and
 * private-repository coverage, not access. `token-required` is emitted only if
 * GitHub actually refuses an anonymous search (401).
 *
 * Day boundary: `author-date:` is judged by GitHub against the commit's own
 * timestamp (observed as `2026-11-04T18:01:30.000+08:00`), so a commit at
 * 00:30 Shanghai can sit in the neighbouring UTC date. This asks for one day on
 * each side and re-filters with `dayInZone`, keeping the cell the heatmap draws.
 * @param {string} login
 * @param {string|null} token
 * @param {string} date `YYYY-MM-DD`
 * @param {string|null} proxyUrl
 * @param {number} timeoutMs
 * @param {string} timeZone
 */
async function githubDayCommits(login, token, date, proxyUrl, timeoutMs, timeZone = 'Asia/Shanghai') {
  // GitHub judges `author-date:` against the commit's own timestamp, and the
  // heatmap buckets days in the configured timezone. Ask for one day on each
  // side and re-filter locally, so a commit that is 2026-11-04 in Shanghai but
  // 2026-11-03 in UTC still lands in the right cell.
  const from = shiftDay(date, -1)
  const to = shiftDay(date, 1)
  const params = new URLSearchParams({
    q: `author:${login} author-date:${from}..${to}`,
    per_page: String(GITHUB_COMMIT_SEARCH_PER_PAGE),
  })

  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  if (token) headers.authorization = `bearer ${token}`

  const response = await httpsCall(`${GITHUB_API}/search/commits?${params.toString()}`, {
    headers,
    proxyUrl,
    timeoutMs,
  })
  try {
    assertOk(response, 'github')
  } catch (error) {
    // Keep the documented code for the only case that really means it: GitHub
    // refusing an anonymous search. A rate limit stays a rate limit.
    if (!token && error instanceof CallError && error.code === 'auth-failed') {
      throw new CallError('token-required', 'GitHub 按天查提交需要令牌。')
    }
    throw error
  }

  const json = parseJson(response.text, 'github')
  const items = Array.isArray(json.items) ? json.items : []
  const total = Number(json.total_count)

  const commits = []
  let dropped = 0
  for (const item of items) {
    if (!item || typeof item.sha !== 'string') continue
    const commit = item.commit || {}
    const stamp =
      (commit.author && commit.author.date) || (commit.committer && commit.committer.date)
    const parsed = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
    const at = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
    // Re-bucket to the configured timezone; a null timestamp keeps the row
    // because the search already matched the author and date.
    if (at !== null && dayInZone(at, timeZone) !== date) {
      dropped += 1
      continue
    }
    commits.push({
      source: 'github',
      sha: item.sha,
      short: item.sha.slice(0, 7),
      subject: commitSubject(commit.message),
      repo:
        item.repository && typeof item.repository.full_name === 'string'
          ? item.repository.full_name
          : null,
      url: typeof item.html_url === 'string' ? item.html_url : null,
      at,
    })
  }

  const truncated = items.length >= GITHUB_COMMIT_SEARCH_PER_PAGE
  const warnings = []
  if (dropped > 0) {
    warnings.push(
      `为对齐 ${timeZone} 的日界，已排除 ${dropped} 条落在相邻日期的提交（GitHub 按提交时间戳判日）。`,
    )
  }
  if (truncated) {
    warnings.push(
      `GitHub 只返回了前 ${commits.length} 条（共 ${Number.isFinite(total) ? total : '未知'} 条），其余被省略。`,
    )
  }

  return { ok: true, commits, truncated, warnings }
}

/**
 * Gitee: the push event stream is the only anonymous source of individual
 * commits. Two limits travel with the result instead of being hidden:
 *
 * - Only the newest 100 events exist, and Gitee ignores `page` (measured:
 *   `?limit=100&page=2` returns the same 100 rows), so older days simply cannot
 *   be resolved.
 * - A commit carries no timestamp of its own; the day comes from its push
 *   event's `created_at` (bucketed in Asia/Shanghai). Several commits of one
 *   push therefore always land on the same day.
 * @param {string} login
 * @param {string|null} token
 * @param {string} date `YYYY-MM-DD`
 * @param {string|null} proxyUrl
 * @param {number} timeoutMs
 */
async function giteeDayCommits(login, token, date, proxyUrl, timeoutMs) {
  const warnings = []
  const params = new URLSearchParams({ limit: String(GITEE_EVENT_LIMIT) })
  let path
  if (token) {
    params.set('access_token', token)
    path = '/users/' + encodeURIComponent(login) + '/events'
  } else {
    path = '/users/' + encodeURIComponent(login) + '/events/public'
    warnings.push(WARN_GITEE_NO_TOKEN)
  }

  const response = await httpsCall(`${GITEE_API}${path}?${params.toString()}`, {
    proxyUrl,
    timeoutMs,
  })
  assertOk(response, 'gitee')

  const events = parseJson(response.text, 'gitee')
  if (!Array.isArray(events)) {
    const message = (events && (events.message || events.error)) || '不是数组'
    throw new CallError('bad-response', `Gitee 事件接口返回异常：${message}`)
  }

  const commits = []
  let missingDetails = 0
  for (const event of events) {
    if (!event || event.type !== 'PushEvent') continue
    // A commit has no clock of its own; the push's created_at decides the day.
    if (shanghaiDay(event.created_at) !== date) continue

    const payload = event.payload || {}
    const list = Array.isArray(payload.commits) ? payload.commits : []
    if (list.length === 0 && Number(payload.size) > 0) missingDetails += 1

    const parsed = Date.parse(event.created_at)
    const at = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
    const repo =
      event.repo && typeof event.repo.full_name === 'string' ? event.repo.full_name : null

    for (const raw of list) {
      if (!raw || typeof raw.sha !== 'string') continue
      commits.push({
        source: 'gitee',
        sha: raw.sha,
        short: raw.sha.slice(0, 7),
        subject: commitSubject(raw.message),
        repo,
        // Gitee's commit web page lives at /{owner}/{repo}/commit/{sha}; the
        // `commit.url` field points at the api/v5 JSON instead, which is useless
        // to click through from the UI. Inferred from that API URL, not measured.
        url: repo
          ? `https://gitee.com/${repo}/commit/${raw.sha}`
          : typeof raw.url === 'string'
            ? raw.url
            : null,
        at,
      })
    }
  }

  warnings.push('Gitee 的提交没有独立时间戳，只能按所属推事件的 created_at 归日。')
  if (missingDetails > 0) {
    warnings.push(`有 ${missingDetails} 次推送只给了提交数量、没有返回提交明细。`)
  }

  const truncated = events.length >= GITEE_EVENT_LIMIT
  if (truncated) {
    warnings.push(`只覆盖最近 ${GITEE_EVENT_LIMIT} 条事件，更早日期查不到。`)
  }

  return { ok: true, commits, truncated, warnings }
}

/**
 * List the individual commits that make up one remote contribution day.
 *
 * Used when a heatmap cell has a remote count but no local commits: the UI can
 * show "which commits were these" instead of a bare number.
 *
 * Never throws; every failure resolves `{ok:false, error:{code, message}}`.
 *
 * @param {object} options
 * @param {'github'|'gitee'} options.provider
 * @param {string} options.login
 * @param {string} [options.token]
 * @param {string} options.date `YYYY-MM-DD`
 * @param {string} [options.proxyUrl]
 * @param {string} [options.timeZone] 归日时区，默认 `Asia/Shanghai`
 * @param {number} [options.timeoutMs]
 * @returns {Promise<
 *   {ok:true, commits:Array<{source:'github'|'gitee', sha:string, short:string, subject:string, repo:string|null, url:string|null, at:number|null}>, truncated:boolean, warnings:string[]}
 *   | {ok:false, error:{code:string, message:string}}>}
 */
export async function fetchDayCommits(options) {
  const input = options && typeof options === 'object' ? options : {}
  const provider = input.provider
  if (provider !== 'github' && provider !== 'gitee') {
    return fail('invalid-argument', `provider 必须是 github 或 gitee，收到 ${String(provider)}`)
  }

  const login = typeof input.login === 'string' ? input.login.trim() : ''
  if (!login) return fail('invalid-argument', 'login 不能为空。')

  const date = input.date
  if (!isDateString(date)) return fail('invalid-argument', 'date 必须是合法的 YYYY-MM-DD 日期。')

  const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : null
  // Measured 2026-11-06: GitHub's commit search answers anonymously (HTTP 200,
  // `total_count: 4` for senmoxiu/2026-11-04, `x-ratelimit-limit: 10`), so a
  // missing token is NOT a hard failure here — it only costs rate limit and
  // private-repository coverage. `token-required` survives as the answer when
  // GitHub actually refuses the anonymous call (401), see githubDayCommits.

  const proxyUrl =
    typeof input.proxyUrl === 'string' && input.proxyUrl.trim() ? input.proxyUrl.trim() : null
  const timeZone =
    typeof input.timeZone === 'string' && input.timeZone.trim() ? input.timeZone.trim() : 'Asia/Shanghai'
  const timeoutMs =
    Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.min(input.timeoutMs, 120000)
      : DEFAULT_TIMEOUT_MS

  try {
    if (provider === 'github') return await githubDayCommits(login, token, date, proxyUrl, timeoutMs, timeZone)
    return await giteeDayCommits(login, token, date, proxyUrl, timeoutMs)
  } catch (error) {
    if (error instanceof CallError) return fail(error.code, error.message)
    const message = error && error.message ? error.message : String(error)
    return fail('network', `${provider} 单日提交查询失败：${message}`)
  }
}
