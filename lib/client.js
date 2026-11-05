window.__ModuleLoader__.load({
	id: "@senmoxiu/dsh-git-heatmap",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		const React = require("react")
		const h = React.createElement

		/** The panel id shared by the sidebar row and the `main` occupant. */
		const PANEL_ID = "git-heatmap"
		/** Row order among the shell's global panel rows (Plugins 0, Schedule 10, task-board 20). */
		const PANEL_ORDER = 30
		/** Selectable window sizes, widest first; the host caps them via `weeks`. */
		const WEEK_OPTIONS = [53, 26, 12]
		const DEFAULT_WEEKS = 53
		/** Client-only windows: both are cut out of the days the host already shipped. */
		const CHOICE_ALL = "all"
		const CHOICE_CUSTOM = "custom"
		/** Monday-first row captions; only rows 0/2/4 are labelled (一/三/五). */
		const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"]

		// ---------------------------------------------------------------- styles

		const CSS = `
/* min-height:0 lets the page absorb the height that dsh-better-sidebar's bottom
   workbench takes out of the center column (it sets margin-bottom on the column);
   the page scrolls itself instead of overflowing. */
.ghm-page {
  --ghm-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  --ghm-0: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 8%, transparent);
  --ghm-1: color-mix(in srgb, var(--ghm-accent) 22%, transparent);
  --ghm-2: color-mix(in srgb, var(--ghm-accent) 42%, transparent);
  --ghm-3: color-mix(in srgb, var(--ghm-accent) 68%, transparent);
  --ghm-4: var(--ghm-accent);
  display: flex; flex-direction: column; gap: 14px; padding: 22px 26px 28px;
  height: 100%; min-height: 0; overflow: auto; box-sizing: border-box;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.ghm-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ghm-title { margin: 0; font-size: 19px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.ghm-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, #d5d9e0); color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-grow { flex: 1 1 auto; }
.ghm-btn { font-size: 12px; padding: 4px 12px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, #d5d9e0); background: var(--dsw-alias-bg-layer-2, #f5f6f8);
  color: var(--dsw-alias-label-primary, #1f2329); }
.ghm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #eceef2); }
.ghm-btn:disabled { opacity: .55; cursor: default; }
.ghm-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.ghm-link-btn { font-size: 11.5px; padding: 2px 9px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, #d5d9e0); background: transparent;
  color: var(--dsw-alias-label-secondary, #5a6272); }
.ghm-link-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #eceef2); }
.ghm-link-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.ghm-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, #d5d9e0);
  border-radius: 7px; overflow: hidden; }
.ghm-segwrap { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ghm-custom { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ghm-date { font-size: 12px; padding: 2px 8px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2, #d5d9e0);
  background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f2329); }
.ghm-date[data-invalid="1"] { border-color: var(--dsw-alias-state-error-primary, #d1242f); }
.ghm-date:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.ghm-seg-btn { font-size: 12px; padding: 3px 10px; border: 0; cursor: pointer; background: transparent;
  color: var(--dsw-alias-label-secondary, #5a6272); }
.ghm-seg-btn[data-active="1"] { background: var(--dsw-alias-interactive-bg-hover, #eceef2);
  color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; }
.ghm-seg-btn:disabled { cursor: default; opacity: .7; }
.ghm-seg-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: -2px; }
.ghm-card { border: 1px solid var(--dsw-alias-border-l1, #e5e8ee); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff); padding: 14px 16px; }
.ghm-card-title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px;
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #5a6272); letter-spacing: .02em; }
.ghm-muted { font-size: 11.5px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-warn { font-size: 12px; color: var(--dsw-alias-state-error-primary, #d1242f); word-break: break-word; }
.ghm-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; }
.ghm-stat { border: 1px solid var(--dsw-alias-border-l1, #e5e8ee); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff); padding: 10px 12px; }
.ghm-stat-k { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1); margin-bottom: 4px; }
.ghm-stat-v { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1f2329); }
.ghm-stat-s { font-size: 10.5px; margin-top: 2px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-filter-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ghm-repos { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 2px 14px; margin-top: 10px; max-height: 240px; overflow: auto; }
.ghm-repo-item { display: flex; align-items: baseline; gap: 6px; font-size: 12px;
  padding: 2px 0; cursor: pointer; min-width: 0; }
.ghm-repo-item input { margin: 0; cursor: pointer; }
.ghm-repo-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghm-repo-meta { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-repo-item[data-upstream="1"] .ghm-repo-name { color: var(--dsw-alias-label-tertiary, #8b93a1); }
/* remote-source toggle lives in the filter card header, always visible */
.ghm-src { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
  cursor: pointer; color: var(--dsw-alias-label-secondary, #5a6272); }
.ghm-src input { margin: 0; cursor: pointer; }
.ghm-gridwrap { display: flex; gap: 6px; align-items: flex-start; overflow-x: auto; padding-bottom: 6px; }
.ghm-weekdays { flex: none; display: grid; grid-template-rows: repeat(7, 11px); gap: 3px;
  width: 16px; padding-top: 14px; text-align: right;
  font-size: 9px; line-height: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-col { flex: none; display: flex; flex-direction: column; }
.ghm-months { display: grid; grid-auto-flow: column; grid-auto-columns: 11px; gap: 3px;
  height: 11px; margin-bottom: 3px; white-space: nowrap;
  font-size: 9px; line-height: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-month { justify-self: start; }
.ghm-grid { display: grid; grid-template-rows: repeat(7, 11px);
  grid-auto-flow: column; grid-auto-columns: 11px; gap: 3px; }
.ghm-cell, .ghm-swatch { width: 11px; height: 11px; border-radius: 2.5px;
  background: var(--ghm-0); box-sizing: border-box; }
.ghm-cell { appearance: none; -webkit-appearance: none; display: block; margin: 0; padding: 0;
  border: 0; font: inherit; line-height: 0; cursor: pointer;
  min-width: 0; min-height: 0; box-shadow: none; }
.ghm-cell[data-l="1"], .ghm-swatch[data-l="1"] { background: var(--ghm-1); }
.ghm-cell[data-l="2"], .ghm-swatch[data-l="2"] { background: var(--ghm-2); }
.ghm-cell[data-l="3"], .ghm-swatch[data-l="3"] { background: var(--ghm-3); }
.ghm-cell[data-l="4"], .ghm-swatch[data-l="4"] { background: var(--ghm-4); }
/* future days and days outside the painted window stay hidden, not painted as
   level 0 — a cell that reads "0 commits" but is really "not in this window"
   looks like a bug, and (custom) it would also pad the last week */
.ghm-cell[data-future="1"], .ghm-cell[data-outside="1"] { visibility: hidden; }
.ghm-cell:hover { outline: 1.5px solid var(--dsw-alias-label-tertiary, #8b93a1); outline-offset: 1px; }
.ghm-cell:focus-visible { outline: 1.5px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.ghm-cell[data-selected="1"] { outline: 1.5px solid var(--dsw-alias-label-primary, #1f2329); outline-offset: 1px; }
.ghm-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px;
  font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-legend { display: inline-flex; align-items: center; gap: 3px; }
.ghm-note { margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
/* Theme-paired pair: --dsw-specific-tip is a LIGHT chip in the light theme, so
   hard-coded #fff text rendered white-on-white. Follow the theme on both sides. */
.ghm-tip { position: fixed; z-index: 70; transform: translate(-50%, -100%); pointer-events: none;
  max-width: 280px; padding: 5px 9px; border-radius: 6px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2329);
  border: 1px solid var(--dsw-alias-border-l2, #d5d9e0);
  font-size: 11.5px; line-height: 1.5; box-shadow: 0 6px 18px rgba(0, 0, 0, .18); }
/* no room above the cell: drop below it instead of clipping at the viewport top */
.ghm-tip[data-place="below"] { transform: translate(-50%, 0); }
.ghm-tip-k { font-variant-numeric: tabular-nums; }
.ghm-tip-r { color: var(--dsw-alias-label-secondary, #5a6272); }
.ghm-detail-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ghm-commits { display: flex; flex-direction: column; max-height: 320px; overflow: auto; }
.ghm-commit { display: grid; grid-template-columns: 68px minmax(0, 1fr) auto auto; gap: 10px;
  align-items: baseline; padding: 5px 0; font-size: 12.5px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e5e8ee); }
.ghm-commit:first-child { border-top: 0; }
.ghm-sha { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-subject { color: var(--dsw-alias-label-primary, #1f2329);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghm-repo { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-when { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-variant-numeric: tabular-nums; }
.ghm-skel { display: flex; flex-direction: column; gap: 10px; }
.ghm-skel-row { height: 12px; border-radius: 6px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 8%, transparent); }
.ghm-state { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 6px 0 2px; }
.ghm-state-t { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
`
		/** Inject the stylesheet once per document (no CSS-Modules build step). */
		function ensureCss() {
			try {
				if (document.querySelector('style[data-plugin-css="dsh-git-heatmap"]')) return
				const style = document.createElement("style")
				style.setAttribute("data-plugin-css", "dsh-git-heatmap")
				style.textContent = CSS
				document.head.appendChild(style)
			} catch {
				// a headless/partial shell simply renders unstyled
			}
		}

		// ------------------------------------------------------------------- api

		/**
		 * POST one JSON payload to a host route. The path is DOCUMENT-RELATIVE
		 * (no leading slash): the GUI is served behind a "base href=./" tag, so a
		 * root-absolute path escapes a sub-path deployment prefix.
		 * @param path - route path, e.g. "git-heat/heat".
		 * @param payload - JSON body.
		 * @returns the decoded envelope; never throws.
		 */
		async function post(path, payload) {
			let response
			try {
				response = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload ?? {}),
				})
			} catch {
				return { ok: false, error: { code: "transport", message: "route unreachable" } }
			}
			try {
				const envelope = await response.json()
				if (envelope && typeof envelope === "object" && envelope.ok === true) {
					return { ok: true, value: envelope.value }
				}
				const error = envelope && envelope.error ? envelope.error : null
				return {
					ok: false,
					error: error ?? { code: "http-" + response.status, message: "unexpected response" },
				}
			} catch {
				return { ok: false, error: { code: "decode", message: "response was not JSON" } }
			}
		}

		// ----------------------------------------------------------------- dates

		/** Zero-padded two-digit segment. */
		function pad2(value) {
			return value < 10 ? "0" + value : String(value)
		}

		/**
		 * Local-timezone `YYYY-MM-DD`. Never `toISOString()`: UTC rolls the day
		 * back for every timezone east of Greenwich.
		 * @param date - the local date to key.
		 */
		function dayKey(date) {
			return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
		}

		/** Day arithmetic at 12:00 local, so a DST jump can never roll the date over. */
		function addDays(date, days) {
			return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12, 0, 0, 0)
		}

		/** Parse a `YYYY-MM-DD` key back into a local noon Date; null when malformed. */
		function parseDayKey(key) {
			const parts = String(key).split("-")
			if (parts.length !== 3) return null
			const year = Number(parts[0])
			const month = Number(parts[1])
			const day = Number(parts[2])
			if (!year || !month || !day) return null
			return new Date(year, month - 1, day, 12, 0, 0, 0)
		}

		/** Local `YYYY-MM-DD` for a unix-seconds timestamp (`at`, `firstCommitAt`, …). */
		function dayFromSeconds(seconds) {
			if (typeof seconds !== "number" || !isFinite(seconds)) return ""
			return dayKey(new Date(seconds * 1000))
		}

		/** Coarse "n 分钟前" style distance, in the user's own clock. */
		function relativeTime(seconds, nowMs) {
			if (typeof seconds !== "number" || !isFinite(seconds)) return ""
			const delta = nowMs - seconds * 1000
			const minute = 60000
			const hour = 60 * minute
			const day = 24 * hour
			if (delta < minute) return "刚刚"
			if (delta < hour) return Math.floor(delta / minute) + " 分钟前"
			if (delta < day) return Math.floor(delta / hour) + " 小时前"
			if (delta < 30 * day) return Math.floor(delta / day) + " 天前"
			if (delta < 365 * day) return Math.floor(delta / (30 * day)) + " 个月前"
			return Math.floor(delta / (365 * day)) + " 年前"
		}

		// --------------------------------------------------------------- windows

		/** The host's configured window cap (`weeks`); older payloads omit it. */
		function hostWeeks(raw) {
			const value = raw && typeof raw.weeks === "number" && isFinite(raw.weeks) ? Math.floor(raw.weeks) : 0
			return value > 0 ? value : DEFAULT_WEEKS
		}

		/**
		 * Selectable windows for this payload. The host only ships `weeks` columns
		 * of data, so a wider preset than that would paint empty margins; a `weeks`
		 * at or above 53 is not offered as a preset because that slot IS "全部".
		 * "全部" and "自定义" are cut client-side, so they never cost a request.
		 * @param raw - the Model envelope payload.
		 */
		function windowOptions(raw) {
			const cap = hostWeeks(raw)
			const presets = WEEK_OPTIONS.filter((preset) => preset <= cap)
			if (cap < WEEK_OPTIONS[0] && presets.indexOf(cap) < 0) presets.push(cap)
			presets.sort((left, right) => right - left)
			return presets.map(String).concat([CHOICE_ALL, CHOICE_CUSTOM])
		}

		/** Segment caption for one window option value. */
		function optionLabel(value) {
			if (value === CHOICE_ALL) return "全部"
			if (value === CHOICE_CUSTOM) return "自定义"
			return value + " 周"
		}

		/** Monday on or before `date` (JS Sun=0 remapped to Mon=0). */
		function mondayOf(date) {
			return addDays(date, -((date.getDay() + 6) % 7))
		}

		/** Sunday on or after `date`. */
		function sundayOf(date) {
			return addDays(date, 6 - ((date.getDay() + 6) % 7))
		}

		/** Whole days between two noon-anchored dates. */
		function daysBetween(from, to) {
			return Math.round((to.getTime() - from.getTime()) / 86400000)
		}

		/** Earliest day the payload actually carries; falls back to `range.from`. */
		function earliestDayKey(raw) {
			let earliest = null
			const days = raw && Array.isArray(raw.days) ? raw.days : []
			for (const day of days) {
				if (day && typeof day.date === "string" && (earliest === null || day.date < earliest)) earliest = day.date
			}
			if (earliest) return earliest
			return raw && raw.range && typeof raw.range.from === "string" ? raw.range.from : null
		}

		/**
		 * The window ends on the host's `range.to` and only shrinks from there.
		 * `range.to` is a Sunday, so snapping forward keeps the Monday-first rows
		 * aligned; extra days past it simply have no data.
		 * @param raw - the Model envelope payload.
		 * @param today - fallback reference day when `range.to` is absent.
		 */
		function windowEnd(raw, today) {
			const to = raw && raw.range && typeof raw.range.to === "string" ? parseDayKey(raw.range.to) : null
			if (!to) return addDays(today, 6 - ((today.getDay() + 6) % 7))
			return to.getDay() === 0 ? to : addDays(to, 6 - ((to.getDay() + 6) % 7))
		}

		/**
		 * "" when the custom draft is usable, otherwise why it is not.
		 * @param draft - {from, to} as typed into the two date inputs.
		 * @param minDay - earliest day the payload carries.
		 * @param maxDay - `range.to`, the newest day the payload carries.
		 */
		function validateCustom(draft, minDay, maxDay) {
			if (!draft || !draft.from || !draft.to) return "请选择起止日期"
			if (draft.from > draft.to) return "起始日期不能晚于结束日期"
			if (minDay && draft.from < minDay) return "起始日期早于最早数据（" + minDay + "）"
			if (maxDay && draft.to > maxDay) return "结束日期晚于窗口末端（" + maxDay + "）"
			return ""
		}

		/**
		 * Resolve one window request into grid geometry. Presets shrink from
		 * `range.to`; "全部" starts at the earliest shipped day; "自定义" honours
		 * the picked endpoints. Every path snaps to whole Monday–Sunday columns,
		 * so the 7 rows stay aligned and column 0 always starts a week.
		 * @param raw - the Model envelope payload.
		 * @param choice - option value ("53" / "26" / "12" / "all" / "custom").
		 * @param applied - {from, to} of the last applied custom range, if any.
		 * @param today - fallback reference day when `range.to` is absent.
		 * @returns {{first: Date, last: Date, columns: number, kind: string,
		 *   label: string, sub: string}}
		 */
		function resolveWindow(raw, choice, applied, today) {
			const cap = hostWeeks(raw)
			const end = windowEnd(raw, today)
			const earliest = earliestDayKey(raw)
			if (choice === CHOICE_CUSTOM && applied && applied.from && applied.to) {
				const from = parseDayKey(applied.from)
				const to = parseDayKey(applied.to)
				if (from && to && from.getTime() <= to.getTime()) {
					const first = mondayOf(from)
					const last = sundayOf(to)
					const columns = Math.max(1, Math.round((daysBetween(first, last) + 1) / 7))
					return { first: first, last: last, columns: columns, kind: CHOICE_CUSTOM, label: applied.from + " → " + applied.to, sub: "" }
				}
			}
			if (choice === CHOICE_ALL) {
				const start = earliest ? parseDayKey(earliest) : null
				const first = mondayOf(start || addDays(end, -(DEFAULT_WEEKS * 7 - 1)))
				const columns = Math.max(1, Math.round((daysBetween(first, end) + 1) / 7))
				return {
					first: first,
					last: end,
					columns: columns,
					kind: CHOICE_ALL,
					label: "全部历史",
					sub: earliest ? earliest + " 起 · " + columns + " 周" : "",
				}
			}
			// "custom" without an applied range (or any unknown value) falls back to
			// the default preset, never to the host cap
			const weeks = Math.max(1, Math.min(Number(choice) || DEFAULT_WEEKS, cap))
			return {
				first: addDays(end, -(weeks * 7 - 1)),
				last: end,
				columns: weeks,
				kind: "preset",
				label: "近 " + weeks + " 周",
				sub: "",
			}
		}

		// ----------------------------------------------------------------- scale

		/** Nearest-rank quantile of an ascending array (index = ceil(p * n) - 1). */
		function nearestRank(sorted, p) {
			if (!sorted.length) return 0
			const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
			return sorted[index]
		}

		/**
		 * Recompute the 5-step colour scale from a count sample. The host's
		 * `day.level` is tied to the 53-week window, so every window/filter change
		 * has to rebuild the scale from the counts it is about to paint.
		 *
		 * Sparse samples fall back to raw values: when the busiest day has 4
		 * commits or fewer, nearest-rank quantiles collapse (a repo of one-commit
		 * days yields q1=1/q2=2/q3=3, so every non-zero cell paints level 1 and
		 * the filter looks broken). GitHub has the same problem, and the reference
		 * implementation solves it the same way — see research/03-ui-grid.md §3.2.
		 * @param counts - 当前窗口 + 当前仓库筛选后、所有 count > 0 的每日提交数
		 *   （未排序；内部会升序排序并取最近秩分位）。
		 * @returns {{q1: number, q2: number, q3: number, max: number, size: number, mode: 'rank'|'absolute'}}
		 *   `mode: 'absolute'` 表示稀疏样本，分级直接用原始提交数（1/2/3/4 级）。
		 */
		function buildScale(counts) {
			const sorted = counts.filter((value) => typeof value === "number" && value > 0).sort((left, right) => left - right)
			const size = sorted.length
			const max = size ? sorted[size - 1] : 0
			if (max <= 4) {
				// Sparse: thresholds are the integer counts themselves, so a day with
				// 1 commit stays level 1 and a day with 4 reaches level 4.
				return { q1: 1, q2: 2, q3: 3, max: max, size: size, mode: "absolute" }
			}
			const q1 = nearestRank(sorted, 0.25)
			const q2 = Math.max(nearestRank(sorted, 0.5), q1 > 0 ? q1 + 1 : 1)
			const q3 = Math.max(nearestRank(sorted, 0.75), q2 + 1)
			return { q1: q1, q2: q2, q3: q3, max: max, size: size, mode: "rank" }
		}

		/** Map one day's count onto the recomputed scale (0 = no commits). */
		function levelFor(count, scale) {
			if (!count || count <= 0) return 0
			if (count <= scale.q1) return 1
			if (count <= scale.q2) return 2
			if (count <= scale.q3) return 3
			return 4
		}

		// ----------------------------------------------------------------- model

		/**
		 * Remote-source totals + status rows. A payload without the remote feature
		 * simply reports `present: false`, so the UI degrades to local-only.
		 * @param raw - the Model envelope payload.
		 * @param days - its `days` array.
		 */
		function remoteSummary(raw, days) {
			const totals = { github: 0, gitee: 0 }
			let any = false
			for (const day of days) {
				if (!day || !day.remote) continue
				const github = typeof day.remote.github === "number" ? day.remote.github : 0
				const gitee = typeof day.remote.gitee === "number" ? day.remote.gitee : 0
				totals.github += github
				totals.gitee += gitee
				if (github || gitee) any = true
			}
			const statsRemote = raw && raw.stats && raw.stats.remote ? raw.stats.remote : null
			const github = statsRemote && typeof statsRemote.github === "number" ? statsRemote.github : totals.github
			const gitee = statsRemote && typeof statsRemote.gitee === "number" ? statsRemote.gitee : totals.gitee
			return {
				present: any || github > 0 || gitee > 0,
				github: github,
				gitee: gitee,
				status: raw && Array.isArray(raw.remoteStatus) ? raw.remoteStatus : [],
			}
		}

		/** One human line for `remoteStatus`; "" when the host reports nothing. */
		function remoteStatusText(status) {
			if (!Array.isArray(status) || !status.length) return ""
			const labels = []
			for (const item of status) {
				if (!item) continue
				const name = item.provider === "github" ? "GitHub" : item.provider === "gitee" ? "Gitee" : String(item.provider || "远程")
				if (item.ok === true) {
					labels.push(name + " ✓ " + (typeof item.days === "number" ? item.days : 0) + " 天")
					continue
				}
				const code = item.error && item.error.code ? item.error.code : ""
				if (code === "not-configured") labels.push(name + " 未配置")
				else if (code === "auth-failed") labels.push(name + " 认证失败")
				else if (code === "rate-limited") labels.push(name + " 触发限流")
				else labels.push(name + " 失败" + (code ? "（" + code + "）" : ""))
			}
			return labels.join(" · ")
		}

		/**
		 * Turn the host Model into the render tree for one (window, repo-filter)
		 * pair: N columns of 7 cells, month anchors, per-day commit lookup, the
		 * recomputed colour scale and the stats card values.
		 * `days` carries only non-zero days the host chose to ship, so empty cells
		 * are synthesised here and every window/filter cut happens client-side.
		 * @param raw - the Model envelope payload.
		 * @param choice - window option value; see resolveWindow.
		 * @param applied - {from, to} of the applied custom range, if any.
		 * @param selectedIds - repo ids to keep, or null for "all repos".
		 * @param includeRemote - count the remote (GitHub/Gitee) part of each day.
		 * @param today - the reference day (future cells stay hidden).
		 */
		function buildModel(raw, choice, applied, selectedIds, includeRemote, today) {
			const cap = hostWeeks(raw)
			const window = resolveWindow(raw, choice, applied, today)
			const columns = window.columns
			const first = window.first
			const todayNoon = addDays(today, 0)
			const days = raw && Array.isArray(raw.days) ? raw.days : []
			const dayByKey = new Map()
			for (const day of days) {
				if (day && typeof day.date === "string") dayByKey.set(day.date, day)
			}
			const repos = raw && Array.isArray(raw.repos) ? raw.repos : []
			const repoName = new Map()
			const repoById = new Map()
			for (const repo of repos) {
				if (!repo || !repo.id) continue
				repoName.set(repo.id, repo.name || repo.id)
				repoById.set(repo.id, repo)
			}
			const keep = selectedIds === null ? null : new Set(selectedIds)
			const dataFrom = earliestDayKey(raw)
			const dataTo =
				raw && raw.range && typeof raw.range.to === "string"
					? raw.range.to
					: columns > 0
						? dayKey(addDays(first, columns * 7 - 1))
						: null
			// Cells outside the painted window are hidden, never painted as level 0.
			// "自定义" clips to the picked endpoints, everything else to the payload
			// bounds, so the Monday/Sunday padding of the last week stops showing.
			const boundsFrom = choice === CHOICE_CUSTOM && applied && applied.from ? applied.from : dataFrom
			const boundsTo = choice === CHOICE_CUSTOM && applied && applied.to ? applied.to : dataTo

			// pass 1: per-day counts after the repo filter and the remote toggle
			const drafts = []
			for (let index = 0; index < columns * 7; index += 1) {
				const date = addDays(first, index)
				const key = dayKey(date)
				const entry = dayByKey.get(key) || null
				const outside = Boolean((boundsFrom && key < boundsFrom) || (boundsTo && key > boundsTo))
				let count = 0
				let local = 0
				let remoteGithub = 0
				let remoteGitee = 0
				let repoCounts = null
				if (entry && !outside) {
					// `count` is already local + remote; `local` keeps the split usable,
					// and remote commits belong to no repo so a repo filter keeps them
					remoteGithub = entry.remote && typeof entry.remote.github === "number" ? entry.remote.github : 0
					remoteGitee = entry.remote && typeof entry.remote.gitee === "number" ? entry.remote.gitee : 0
					const remoteSum = remoteGithub + remoteGitee
					local = typeof entry.local === "number" ? entry.local : Math.max(0, (entry.count || 0) - remoteSum)
					const remotePart = includeRemote ? remoteSum : 0
					if (keep === null) {
						count = includeRemote
							? typeof entry.count === "number"
								? entry.count
								: local + remoteSum
							: local
						repoCounts = entry.repos || null
					} else {
						repoCounts = {}
						const source = entry.repos || {}
						for (const id of Object.keys(source)) {
							if (!keep.has(id)) continue
							const value = typeof source[id] === "number" ? source[id] : 0
							if (!value) continue
							repoCounts[id] = value
							count += value
						}
						count += remotePart
					}
				}
				drafts.push({
					key: key,
					date: date,
					count: count,
					local: local,
					remoteGithub: remoteGithub,
					remoteGitee: remoteGitee,
					repoCounts: repoCounts,
					outside: outside,
					future: date.getTime() > todayNoon.getTime(),
					level: 0,
				})
			}

			// pass 2: the scale always follows the counts actually being painted
			const scale = buildScale(drafts.map((draft) => draft.count))
			for (const draft of drafts) draft.level = levelFor(draft.count, scale)

			// stats over exactly what the grid shows
			let total = 0
			let activeDays = 0
			let longest = 0
			let run = 0
			let previous = null
			let busiest = null
			for (const draft of drafts) {
				if (draft.future || !draft.count) continue
				total += draft.count
				activeDays += 1
				if (previous && dayKey(addDays(previous, 1)) === draft.key) run += 1
				else run = 1
				previous = draft.date
				if (run > longest) longest = run
				if (!busiest || draft.count > busiest.count) busiest = { date: draft.key, count: draft.count }
			}

			// commits of the selected repos, bucketed per day and clipped to the window
			const commitsByDay = new Map()
			const commits = raw && Array.isArray(raw.commits) ? raw.commits : []
			const fromKey = drafts.length ? drafts[0].key : ""
			const toKey = drafts.length ? drafts[drafts.length - 1].key : ""
			for (const commit of commits) {
				if (!commit) continue
				if (keep !== null && !keep.has(commit.repoId)) continue
				let key = typeof commit.day === "string" ? commit.day : ""
				if (!key && typeof commit.at === "number") key = dayFromSeconds(commit.at)
				if (!key || key < fromKey || key > toKey) continue
				const bucket = commitsByDay.get(key)
				if (bucket) bucket.push(commit)
				else commitsByDay.set(key, [commit])
			}
			for (const bucket of commitsByDay.values()) {
				bucket.sort((left, right) => (right.at || 0) - (left.at || 0))
			}

			// columns + month anchors
			const weeksGrid = []
			const monthAnchors = []
			const cellByKey = new Map()
			for (let column = 0; column < columns; column += 1) {
				const slice = drafts.slice(column * 7, column * 7 + 7)
				let monthLabel = ""
				for (const cell of slice) {
					cellByKey.set(cell.key, cell)
					// only a real 1st of the month is a label anchor; the
					// first-appearance heuristic mislabels the leading tail
					if (!monthLabel && !cell.future && cell.date.getDate() === 1) {
						monthLabel = cell.date.getMonth() + 1 + "月"
					}
				}
				weeksGrid.push(slice)
				monthAnchors.push(monthLabel)
			}

			const statsRaw = (raw && raw.stats) || {}
			const allTime = statsRaw.allTime || null
			return {
				columns: columns,
				weeks: weeksGrid,
				monthAnchors: monthAnchors,
				cellByKey: cellByKey,
				repoName: repoName,
				repoById: repoById,
				commitsByDay: commitsByDay,
				scale: scale,
				repoCount: repos.length,
				windowFrom: fromKey,
				windowTo: toKey,
				window: window,
				remote: remoteSummary(raw, days),
				includeRemote: includeRemote !== false,
				hostWeeks: cap,
				stats: {
					total: total,
					activeDays: activeDays,
					longestStreak: longest,
					busiest: busiest,
					allTime: allTime,
				},
				timezone: raw && typeof raw.timezone === "string" ? raw.timezone : "Asia/Shanghai",
			}
		}

		// ------------------------------------------------------------ components

		/**
		 * The sidebar row glyph. The shell owns the button, label, tooltip and rail
		 * geometry; this component draws only the glyph at the requested size.
		 * Carries `data-dsh-panel-entry` so skin layers can resolve the row.
		 * @param props - the shell's icon share.
		 */
		function HeatmapPanelIcon({ size }) {
			const edge = typeof size === "number" && size > 0 ? size : 16
			return h(
				"svg",
				{
					viewBox: "0 0 16 16",
					width: edge,
					height: edge,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"data-dsh-panel-entry": PANEL_ID,
					"aria-hidden": "true",
				},
				h("rect", { key: "a", x: 1.5, y: 1.5, width: 3.2, height: 3.2, rx: 0.7, fill: "currentColor", opacity: 0.35 }),
				h("rect", { key: "b", x: 6.4, y: 1.5, width: 3.2, height: 3.2, rx: 0.7, fill: "currentColor", opacity: 0.7 }),
				h("rect", { key: "c", x: 11.3, y: 1.5, width: 3.2, height: 3.2, rx: 0.7, fill: "currentColor" }),
				h("rect", { key: "d", x: 1.5, y: 6.4, width: 3.2, height: 3.2, rx: 0.7, fill: "currentColor" }),
				h("rect", { key: "e", x: 6.4, y: 6.4, width: 3.2, height: 3.2, rx: 0.7, fill: "currentColor", opacity: 0.35 }),
				h("rect", { key: "f", x: 11.3, y: 6.4, width: 3.2, height: 3.2, rx: 0.7, fill: "currentColor", opacity: 0.7 }),
				h("rect", { key: "g", x: 1.5, y: 11.3, width: 3.2, height: 3.2, rx: 0.7, fill: "currentColor", opacity: 0.7 }),
				h("rect", { key: "h", x: 6.4, y: 11.3, width: 3.2, height: 3.2, rx: 0.7, fill: "currentColor" }),
			)
		}

		/** One stats card. */
		function StatCard({ label, value, hint }) {
			return h(
				"div",
				{ className: "ghm-stat" },
				h("div", { className: "ghm-stat-k" }, label),
				h("div", { className: "ghm-stat-v" }, value),
				hint ? h("div", { className: "ghm-stat-s" }, hint) : null,
			)
		}

		/** Window control: 53 / 26 / 12 周 · 全部 · 自定义 (host cap filters presets). */
		function WindowSwitch({ options, active, sub, onChange }) {
			return h(
				"div",
				{ className: "ghm-segwrap" },
				h(
					"div",
					{ className: "ghm-seg", role: "group", "aria-label": "时间窗" },
					options.map((option) =>
						h(
							"button",
							{
								key: option,
								type: "button",
								className: "ghm-seg-btn",
								"data-active": option === active ? "1" : "0",
								"aria-pressed": option === active ? "true" : "false",
								onClick: () => onChange(option),
							},
							optionLabel(option),
						),
					),
				),
				sub ? h("span", { className: "ghm-muted" }, sub) : null,
			)
		}

		/**
		 * Collapsible repo checklist. Selection is a pure client concern: the host
		 * always ships every repo, the grid filters them.
		 */
		function RepoFilter({
			repos,
			isChecked,
			selectedCount,
			open,
			includeRemote,
			remotePresent,
			onToggleOpen,
			onToggleRepo,
			onToggleRemote,
			onSelectAll,
			onSelectOwn,
			onClear,
		}) {
			const items = repos.map((repo) =>
				h(
					"label",
					{
						key: repo.id,
						className: "ghm-repo-item",
						"data-upstream": repo.originKind === "upstream" ? "1" : "0",
					},
					h("input", {
						type: "checkbox",
						checked: isChecked(repo.id),
						onChange: () => onToggleRepo(repo.id),
					}),
					h("span", { className: "ghm-repo-name" }, repo.name || repo.id),
					h(
						"span",
						{ className: "ghm-repo-meta" },
						kindLabel(repo.originKind) + " · " + (typeof repo.myCommitCount === "number" ? repo.myCommitCount : 0),
					),
				),
			)
			return h(
				"div",
				{ className: "ghm-card" },
				h(
					"div",
					{ className: "ghm-filter-head" },
					h(
						"button",
						{
							className: "ghm-btn",
							type: "button",
							"aria-expanded": open ? "true" : "false",
							onClick: onToggleOpen,
						},
						open ? "收起仓库筛选" : "仓库筛选",
					),
					h("span", { className: "ghm-muted" }, "已选 " + selectedCount + " / " + repos.length),
					remotePresent
						? h(
								"label",
								{ className: "ghm-src" },
								h("input", { type: "checkbox", checked: includeRemote, onChange: onToggleRemote }),
								"包含远程贡献",
							)
						: null,
					h("span", { className: "ghm-grow" }),
					h("button", { className: "ghm-link-btn", type: "button", onClick: onSelectAll }, "全选"),
					h("button", { className: "ghm-link-btn", type: "button", onClick: onSelectOwn }, "只选 own"),
					h("button", { className: "ghm-link-btn", type: "button", onClick: onClear }, "清空"),
				),
				open ? h("div", { className: "ghm-repos" }, items) : null,
			)
		}

		/** Human label for `originKind`. */
		function kindLabel(kind) {
			if (kind === "own") return "自有"
			if (kind === "team") return "团队"
			if (kind === "upstream") return "上游"
			if (kind === "empty") return "空仓"
			return "未知"
		}

		/** Repo names that contributed on one day, largest count first. */
		function repoLabelsFor(cell, model, limit) {
			const found = []
			const counts = cell.repoCounts || {}
			for (const id of Object.keys(counts)) {
				found.push({ name: model.repoName.get(id) || id, count: counts[id] || 0 })
			}
			if (!found.length) {
				const seen = new Set()
				for (const commit of model.commitsByDay.get(cell.key) || []) {
					const name = model.repoName.get(commit.repoId) || commit.repoId || "未知仓库"
					if (seen.has(name)) continue
					seen.add(name)
					found.push({ name: name, count: 1 })
				}
			}
			found.sort((left, right) => right.count - left.count)
			return found.slice(0, limit).map((item) => item.name)
		}

		/** The N×7 grid: Monday-first rows, columns flow left to right. */
		function HeatmapGrid({ model, selectedKey, onHover, onLeave, onSelect }) {
			const cells = []
			model.weeks.forEach((column, weekIndex) => {
				column.forEach((cell, rowIndex) => {
					const selected = selectedKey === cell.key
					cells.push(
						h("button", {
							key: cell.key,
							type: "button",
							className: "ghm-cell",
							"data-l": String(cell.level),
							"data-future": cell.future ? "1" : "0",
							"data-outside": cell.outside ? "1" : "0",
							"data-selected": selected ? "1" : "0",
							"data-week": String(weekIndex + 1),
							"data-row": String(rowIndex),
							tabIndex: cell.future || cell.outside ? -1 : 0,
							"aria-label": cell.key + " · " + cell.count + " 次提交",
							"aria-pressed": selected ? "true" : "false",
							onMouseEnter: (event) => onHover(cell, event.currentTarget),
							onMouseLeave: onLeave,
							onFocus: (event) => onHover(cell, event.currentTarget),
							onBlur: onLeave,
							onClick: () => onSelect(cell.key),
						}),
					)
				})
			})
			return h(
				"div",
				{ className: "ghm-gridwrap", onScroll: onLeave },
				h(
					"div",
					{ className: "ghm-weekdays" },
					WEEKDAY_LABELS.map((label, index) =>
						h("div", { key: index }, index === 0 || index === 2 || index === 4 ? label : ""),
					),
				),
				h(
					"div",
					{ className: "ghm-col" },
					h(
						"div",
						{ className: "ghm-months" },
						model.monthAnchors.map((label, index) =>
							h("div", { key: index, className: "ghm-month" }, label),
						),
					),
					h("div", { className: "ghm-grid" }, cells),
				),
			)
		}

		/** Hovering a cell only changes the tooltip, so the cells stay put. */
		const MemoGrid = React.memo(HeatmapGrid)

		/** Self-drawn hover card (the native `title` has a ~1s delay and no wraps). */
		function Tooltip({ tip, model, innerRef }) {
			if (!tip) return null
			const cell = tip.cell
			const hasRemote = Boolean(model.remote && model.remote.present)
			const breakdown = []
			if (hasRemote) {
				breakdown.push("本地 " + cell.local)
				if (model.includeRemote) {
					if (cell.remoteGithub) breakdown.push("GitHub " + cell.remoteGithub)
					if (cell.remoteGitee) breakdown.push("Gitee " + cell.remoteGitee)
				}
			}
			const names = hasRemote ? [] : repoLabelsFor(cell, model, 2)
			return h(
				"div",
				{
					className: "ghm-tip",
					role: "tooltip",
					"data-place": tip.place || "above",
					ref: innerRef,
					style: { left: tip.x + "px", top: tip.y + "px" },
				},
				h("div", { className: "ghm-tip-k" }, cell.key + " · " + cell.count + " 次提交"),
				breakdown.length ? h("div", { className: "ghm-tip-r" }, breakdown.join(" · ")) : null,
				names.length ? h("div", { className: "ghm-tip-r" }, names.join("、")) : null,
			)
		}

		/** Commits of the clicked day: subject + 7-char sha + repo + relative time. */
		function DayDetail({ model, selectedKey, onClose }) {
			const cell = model.cellByKey.get(selectedKey)
			const commits = model.commitsByDay.get(selectedKey) || []
			const count = cell ? cell.count : 0
			const nowMs = Date.now()
			const rows = commits.map((commit, index) => {
				// the host's `short` is git's abbreviation and varies (7 or 10 chars),
				// so the "7 位 sha" the panel promises is cut from the full sha here
				const full = typeof commit.sha === "string" && commit.sha ? commit.sha : commit.short
				const sha = typeof full === "string" ? full.slice(0, 7) : ""
				return h(
					"div",
					{ className: "ghm-commit", key: (commit.sha || "commit") + "-" + index },
					h("span", { className: "ghm-sha" }, sha),
					h("span", { className: "ghm-subject" }, commit.subject || "(无标题)"),
					h("span", { className: "ghm-repo" }, model.repoName.get(commit.repoId) || commit.repoId || "—"),
					h("span", { className: "ghm-when" }, relativeTime(commit.at, nowMs)),
				)
			})
			return h(
				"div",
				{ className: "ghm-card" },
				h(
					"div",
					{ className: "ghm-detail-head" },
					h(
						"div",
						{ className: "ghm-card-title", style: { marginBottom: 0 } },
						selectedKey + (cell ? " · " + count + " 次提交" : " · 不在当前窗口"),
					),
					h("span", { className: "ghm-muted" }, "点同一格可取消选择"),
					h("span", { className: "ghm-grow" }),
					h("button", { className: "ghm-btn", type: "button", onClick: onClose }, "取消选择"),
				),
				rows.length
					? h("div", { className: "ghm-commits" }, rows)
					: h(
							"div",
							{ className: "ghm-muted" },
							!cell
								? "该日期不在当前窗口内。"
								: count > 0
									? "该日的提交不在 commits[] 里（宿主只回传最近提交）。"
									: "该日无提交。",
						),
			)
		}

		/** The `main`-slot page. */
		function HeatmapPage() {
			const [state, setState] = React.useState({ phase: "loading", value: null, error: null })
			const [tip, setTip] = React.useState(null)
			const [selectedKey, setSelectedKey] = React.useState(null)
			const [choice, setChoice] = React.useState(null)
			const [selectedIds, setSelectedIds] = React.useState(null)
			const [reposOpen, setReposOpen] = React.useState(false)
			const [custom, setCustom] = React.useState({ from: "", to: "" })
			const [applied, setApplied] = React.useState(null)
			const [includeRemote, setIncludeRemote] = React.useState(true)
			const tipRef = React.useRef(null)

			const load = React.useCallback((refresh) => {
				setTip(null)
				setState((previous) => ({
					phase: previous.value ? "refreshing" : "loading",
					value: previous.value,
					error: null,
				}))
				post("git-heat/heat", { refresh: refresh === true }).then((result) => {
					if (result.ok) {
						setState({ phase: "ready", value: result.value, error: null })
						return
					}
					setState((previous) => {
						if (previous.value) return { phase: "ready", value: previous.value, error: result.error }
						return { phase: "error", value: null, error: result.error }
					})
				})
			}, [])

			React.useEffect(() => {
				load(false)
			}, [load])

			const raw = state.value
			const repos = React.useMemo(() => {
				const list = raw && Array.isArray(raw.repos) ? raw.repos : []
				return list.filter((repo) => repo && repo.id)
			}, [raw])
			const allIds = React.useMemo(() => repos.map((repo) => repo.id), [repos])
			const options = windowOptions(raw)
			const active = choice !== null && options.indexOf(choice) >= 0 ? choice : options[0]
			const dataFrom = raw ? earliestDayKey(raw) : null
			const dataTo = raw && raw.range && typeof raw.range.to === "string" ? raw.range.to : null
			const customError = validateCustom(custom, dataFrom, dataTo)

			const model = React.useMemo(() => {
				if (!raw) return null
				return buildModel(raw, active, applied, selectedIds, includeRemote, new Date())
			}, [raw, active, applied, selectedIds, includeRemote])

			const activeSet = React.useMemo(() => (selectedIds === null ? null : new Set(selectedIds)), [selectedIds])
			const selectedCount = activeSet === null ? allIds.length : allIds.filter((id) => activeSet.has(id)).length
			const isChecked = (id) => activeSet === null || activeSet.has(id)

			const busy = state.phase === "loading" || state.phase === "refreshing"
			const handleHover = React.useCallback((cell, element) => {
				if (!cell || cell.future || cell.outside) return
				const rect = element.getBoundingClientRect()
				const viewport = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280
				const anchorX = rect.left + rect.width / 2
				// first pass: assume the card's widest allowed half-width; the measured
				// pass below replaces this as soon as the node exists in the DOM
				const half = Math.min(280, viewport) / 2
				const lo = half + 8
				const hi = Math.max(lo, viewport - half - 8)
				const above = rect.top - 8
				const flip = above < 8
				setTip({
					cell: cell,
					anchorX: anchorX,
					x: Math.min(Math.max(anchorX, lo), hi),
					y: flip ? rect.bottom + 6 : above,
					place: flip ? "below" : "above",
				})
			}, [])
			// second pass: clamp with the tooltip's real width so the card cannot hang
			// off the left/right edge (runs right after the node is committed)
			React.useLayoutEffect(() => {
				if (!tip) return
				const element = tipRef.current
				if (!element) return
				const viewport = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280
				const half = element.getBoundingClientRect().width / 2
				const lo = half + 8
				const hi = Math.max(lo, viewport - half - 8)
				const x = Math.min(Math.max(tip.anchorX, lo), hi)
				if (Math.abs(x - tip.x) > 0.5) {
					setTip({ cell: tip.cell, anchorX: tip.anchorX, x: x, y: tip.y, place: tip.place })
				}
			}, [tip])
			const handleLeave = React.useCallback(() => setTip(null), [])
			const handleSelect = React.useCallback((key) => {
				setSelectedKey((previous) => (previous === key ? null : key))
			}, [])
			const handleKeyDown = React.useCallback((event) => {
				if (event.key === "Escape") setSelectedKey(null)
			}, [])
			const handleToggleRepo = React.useCallback(
				(id) => {
					// intersect with the current repo list so ids left over from an
					// earlier payload can never inflate the "all selected" check
					const base = new Set(activeSet === null ? allIds : allIds.filter((repoId) => activeSet.has(repoId)))
					if (base.has(id)) base.delete(id)
					else base.add(id)
					setSelectedIds(base.size === allIds.length ? null : Array.from(base))
				},
				[activeSet, allIds],
			)
			const handleSelectAll = React.useCallback(() => setSelectedIds(null), [])
			const handleSelectOwn = React.useCallback(() => {
				setSelectedIds(repos.filter((repo) => repo.originKind === "own").map((repo) => repo.id))
			}, [repos])
			const handleClear = React.useCallback(() => setSelectedIds([]), [])

			// plain closures (not memoized): the switch re-renders the page anyway
			const handleChoose = (value) => {
				if (value === CHOICE_CUSTOM && (!custom.from || !custom.to)) {
					// seed from the data bounds (not the grid bounds: "全部" starts a
					// few days before the first commit), so "应用" is one valid click
					setCustom({
						from: applied ? applied.from : dataFrom || "",
						to: applied ? applied.to : dataTo || "",
					})
				}
				setTip(null)
				setChoice(value)
			}
			const handleApplyCustom = () => {
				if (validateCustom(custom, dataFrom, dataTo)) return
				setApplied({ from: custom.from, to: custom.to })
				setChoice(CHOICE_CUSTOM)
				setSelectedKey(null)
				setTip(null)
			}
			const setCustomField = (field) => (event) => {
				const next = Object.assign({}, custom)
				next[field] = event.target.value
				setCustom(next)
			}

			const badge = raw
				? [raw.stage || "M3", raw.cached === true ? "缓存" : "实时", typeof raw.elapsedMs === "number" ? raw.elapsedMs + "ms" : null]
						.filter(Boolean)
						.join(" · ")
				: "M3 · 本地 git"
			const repoCountText =
				selectedIds === null ? "全部 " + allIds.length + " 个仓库" : allIds.length + " 个仓库中的 " + selectedCount + " 个"

			let body
			if (state.phase === "loading") {
				body = h(
					"div",
					{ className: "ghm-card" },
					h(
						"div",
						{ className: "ghm-skel" },
						h("div", { className: "ghm-skel-row", style: { width: "32%" } }),
						h("div", { className: "ghm-skel-row", style: { width: "58%" } }),
						h("div", { className: "ghm-skel-row", style: { width: "44%" } }),
					),
					h("div", { className: "ghm-note" }, "正在扫描本机仓库的 git 历史…"),
				)
			} else if (state.phase === "error") {
				body = h(
					"div",
					{ className: "ghm-card" },
					h("div", { className: "ghm-card-title" }, "读取失败"),
					h("div", { className: "ghm-warn" }, state.error.code + " · " + state.error.message),
					h("div", { className: "ghm-note" }, "宿主路由 git-heat/heat 未返回数据；确认插件宿主半边已加载。"),
					h(
						"div",
						{ style: { marginTop: "10px" } },
						h("button", { className: "ghm-btn", type: "button", onClick: () => load(true) }, "重试"),
					),
				)
			} else if (!model) {
				body = h("div", { className: "ghm-note" }, "没有可用数据。")
			} else {
				const stats = model.stats
				const scale = model.scale
				const allTime = stats.allTime
				const allTimeText = allTime
					? "全时段 " +
						(typeof allTime.commitCountMine === "number" ? allTime.commitCountMine : "?") +
						" 次提交 · " +
						(typeof allTime.dayCount === "number" ? allTime.dayCount : "?") +
						" 个活跃日" +
						(dayFromSeconds(allTime.firstCommitAt) ? " · " + dayFromSeconds(allTime.firstCommitAt) + " 起" : "")
					: null
				const windowText = model.window.label
				const remoteStatus = remoteStatusText(model.remote.status)
				// remote days are not owned by any repo, so a repo filter keeps them;
				// say so instead of letting the user assume they were filtered out
				const remoteHint =
					model.remote.present && includeRemote && selectedCount < allIds.length ? "远程不受仓库筛选影响" : ""
				const remoteNoteText = [remoteStatus, remoteHint].filter(Boolean).join(" · ")
				const filterEmpty = selectedCount === 0
				// "清空" always shows the empty state, even when remote-only days would
				// still paint — otherwise the action looks half-done
				const nothing = model.stats.total === 0 || filterEmpty

				body = h(
					React.Fragment,
					null,
					h(
						"div",
						{ className: "ghm-stats" },
						h(StatCard, { key: "commits", label: "总提交", value: String(stats.total), hint: windowText + " · 仅本人邮箱提交" }),
						h(StatCard, { key: "days", label: "活跃天数", value: String(stats.activeDays), hint: windowText + " · 至少 1 次提交" }),
						h(StatCard, {
							key: "streak",
							label: "最长连续",
							value: stats.longestStreak + " 天",
							hint: "按自然日衔接",
						}),
						h(StatCard, {
							key: "busiest",
							label: "最忙一天",
							value: stats.busiest ? stats.busiest.count + " 次" : "—",
							hint: stats.busiest ? stats.busiest.date : "窗口内无提交",
						}),
					),
					allTimeText ? h("div", { className: "ghm-note" }, allTimeText) : null,
					state.error
						? h(
								"div",
								{ className: "ghm-card" },
								h("div", { className: "ghm-warn" }, "刷新失败：" + state.error.code + " · " + state.error.message + "（显示上次结果）"),
							)
						: null,
					h(RepoFilter, {
						repos: repos,
						isChecked: isChecked,
						selectedCount: selectedCount,
						open: reposOpen,
						includeRemote: includeRemote,
						remotePresent: model.remote.present,
						onToggleOpen: () => setReposOpen((previous) => !previous),
						onToggleRepo: handleToggleRepo,
						onToggleRemote: () => setIncludeRemote((previous) => !previous),
						onSelectAll: handleSelectAll,
						onSelectOwn: handleSelectOwn,
						onClear: handleClear,
					}),
					nothing
						? h(
								"div",
								{ className: "ghm-card" },
								h(
									"div",
									{ className: "ghm-state" },
									h("div", { className: "ghm-state-t" }, filterEmpty ? "未选择任何仓库" : "窗口内没有提交"),
									h(
										"div",
										{ className: "ghm-note" },
										filterEmpty
											? "勾选至少一个仓库，或点「全选」恢复全部数据。"
											: "本机 " + model.repoCount + " 个仓库 · " + windowText + "（" + model.windowFrom + " → " + model.windowTo + "）内没有扫描到本人提交。",
									),
									h(
										"button",
										{ className: "ghm-btn", type: "button", onClick: filterEmpty ? handleSelectAll : () => load(true), disabled: busy },
										filterEmpty ? "全选" : "重新扫描",
									),
								),
							)
						: h(
								"div",
								{ className: "ghm-card" },
								h(
									"div",
									{ className: "ghm-card-title" },
									"贡献热力图",
									h("span", { className: "ghm-muted" }, windowText + " · 周一 → 周日 · " + model.columns * 7 + " 格"),
								),
								h(MemoGrid, {
									model: model,
									selectedKey: selectedKey,
									onHover: handleHover,
									onLeave: handleLeave,
									onSelect: handleSelect,
								}),
								h(
									"div",
									{ className: "ghm-foot" },
									h("span", null, "少"),
									h(
										"span",
										{ className: "ghm-legend" },
										[0, 1, 2, 3, 4].map((level) =>
											h("span", { key: level, className: "ghm-swatch", "data-l": String(level) }),
										),
									),
									h("span", null, "多"),
									h("span", null, windowText),
									h("span", null, "色阶" + (scale.mode === "absolute"
									? "按原始次数分级（峰值 " + scale.max + " 次，样本稀疏）"
									: "按当前窗口分位：" + scale.q1 + " / " + scale.q2 + " / " + scale.q3)),
								),
								h(
									"div",
									{ className: "ghm-note" },
									"本机 " +
										model.repoCount +
										" 个仓库 · " +
										(model.remote.present
											? includeRemote
												? "本地本人提交 + 远程贡献"
												: "仅本地本人提交"
											: "仅统计本人邮箱提交") +
										" · 时区 " +
										model.timezone +
										" · " +
										model.windowFrom +
										" → " +
										model.windowTo,
								),
								remoteNoteText
									? h("div", { className: "ghm-note" }, remoteNoteText)
									: null,
							),
					selectedKey ? h(DayDetail, { model: model, selectedKey: selectedKey, onClose: () => setSelectedKey(null) }) : null,
					h(Tooltip, { tip: tip, model: model, innerRef: tipRef }),
				)
			}

			return h(
				"div",
				{
					className: "ghm-page",
					"data-dsh-plugin": "git-heatmap",
					onKeyDown: handleKeyDown,
				},
				h(
					"div",
					{ className: "ghm-head" },
					h("h1", { className: "ghm-title" }, "Git 热力图"),
					h("span", { className: "ghm-badge" }, badge),
					h("span", { className: "ghm-muted" }, repoCountText),
					h("span", { className: "ghm-grow" }),
					h(WindowSwitch, {
						options: options,
						active: active,
						sub: model && model.window.kind === CHOICE_ALL ? model.window.sub : "",
						onChange: handleChoose,
					}),
					h(
						"button",
						{ className: "ghm-btn", type: "button", onClick: () => load(true), disabled: busy },
						busy ? "刷新中…" : "刷新",
					),
				),
				active === CHOICE_CUSTOM
					? h(
							"div",
							{ className: "ghm-custom" },
							h("span", { className: "ghm-muted" }, "自定义区间"),
							h("input", {
								className: "ghm-date",
								type: "date",
								"data-invalid": customError ? "1" : "0",
								min: dataFrom || undefined,
								max: dataTo || undefined,
								value: custom.from,
								onChange: setCustomField("from"),
							}),
							h("span", { className: "ghm-muted" }, "→"),
							h("input", {
								className: "ghm-date",
								type: "date",
								"data-invalid": customError ? "1" : "0",
								min: dataFrom || undefined,
								max: dataTo || undefined,
								value: custom.to,
								onChange: setCustomField("to"),
							}),
							h(
								"button",
								{ className: "ghm-btn", type: "button", onClick: handleApplyCustom, disabled: customError !== "" },
								"应用",
							),
							customError
								? h("span", { className: "ghm-warn" }, customError)
								: h("span", { className: "ghm-muted" }, "可选范围 " + (dataFrom || "?") + " → " + (dataTo || "?")),
						)
					: null,
				body,
			)
		}

		// ------------------------------------------------------------------ mount

		/**
		 * Client plugin body: register the sidebar row and the center-column page.
		 * Both seats belong to shell plugins this package does not depend on at
		 * runtime, so each registration is wrapped in `slots.inject`: it runs only
		 * after the owning shell declares the seat, and a shell that never declares
		 * it leaves the panel absent instead of failing boot.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ensureCss()
			ctx.inject(["slots"], (scope) => {
				scope.effect(() => {
					const slots = scope.slots
					const disposers = []
					disposers.push(
						slots.inject("sidebar.panellist", () =>
							slots.register(
								{
									name: "sidebar.panellist",
									id: PANEL_ID,
									order: PANEL_ORDER,
									label: () => "Git 热力图",
								},
								HeatmapPanelIcon,
							),
						),
					)
					disposers.push(
						slots.inject("main", () =>
							slots.register(
								{
									name: "main",
									key: PANEL_ID,
								},
								HeatmapPage,
							),
						),
					)
					return () => {
						for (const dispose of disposers.splice(0)) {
							try {
								dispose()
							} catch {
								// a torn-down shell may already have released it
							}
						}
					}
				}, "dsh-git-heatmap: panel seats")
			})
		}

		exports.apply = apply
		exports.inject = ["slots"]
		exports.PANEL_ID = PANEL_ID
		exports.HeatmapPanelIcon = HeatmapPanelIcon
		exports.HeatmapPage = HeatmapPage
		exports.buildScale = buildScale
		exports.levelFor = levelFor
		exports.buildModel = buildModel
		return module.exports
	},
})
