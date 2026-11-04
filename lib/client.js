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
		/** Rolling window: 53 weeks × 7 days = 371 cells, matching GitHub's rolling year. */
		const WEEK_COUNT = 53
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
  display: flex; flex-direction: column; gap: 16px; padding: 22px 26px 28px;
  height: 100%; min-height: 0; overflow: auto; box-sizing: border-box;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.ghm-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
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
.ghm-cell[data-future="1"] { visibility: hidden; }
.ghm-cell:hover { outline: 1.5px solid var(--dsw-alias-label-tertiary, #8b93a1); outline-offset: 1px; }
.ghm-cell:focus-visible { outline: 1.5px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.ghm-cell[data-selected="1"] { outline: 1.5px solid var(--dsw-alias-label-primary, #1f2329); outline-offset: 1px; }
.ghm-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px;
  font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-legend { display: inline-flex; align-items: center; gap: 3px; }
.ghm-note { margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-tip { position: fixed; z-index: 70; transform: translate(-50%, -100%); pointer-events: none;
  max-width: 280px; padding: 5px 9px; border-radius: 6px; background: var(--dsw-specific-tip, #16181d);
  color: #fff; font-size: 11.5px; line-height: 1.5; box-shadow: 0 6px 18px rgba(0, 0, 0, .24); }
.ghm-tip-k { font-variant-numeric: tabular-nums; }
.ghm-tip-r { color: rgba(255, 255, 255, .72); }
.ghm-detail-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ghm-commits { display: flex; flex-direction: column; max-height: 320px; overflow: auto; }
.ghm-commit { display: grid; grid-template-columns: 68px minmax(0, 1fr) auto; gap: 10px;
  align-items: baseline; padding: 5px 0; font-size: 12.5px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e5e8ee); }
.ghm-commit:first-child { border-top: 0; }
.ghm-sha { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-subject { color: var(--dsw-alias-label-primary, #1f2329);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghm-repo { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
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

		/**
		 * 53 columns ending on the current week's Sunday, Monday-first rows.
		 * `(getDay() + 6) % 7` remaps JS Sun=0 into Mon=0, so `6 - index` walks
		 * forward to Sunday; the first column is then `53 * 7 - 1` days back.
		 * @param today - the reference day.
		 * @param count - week columns (53).
		 */
		function buildWindow(today, count) {
			const last = addDays(today, 6 - ((today.getDay() + 6) % 7))
			const first = addDays(last, -(count * 7 - 1))
			return { first: first, last: last }
		}

		// ----------------------------------------------------------------- model

		/** Trust the host's 0..4 level; fall back to its quantile thresholds. */
		function levelOf(entry, count, thresholds) {
			if (!count) return 0
			const level = entry ? entry.level : null
			if (typeof level === "number" && isFinite(level)) {
				return Math.max(0, Math.min(4, Math.round(level)))
			}
			const q1 = typeof thresholds.q1 === "number" ? thresholds.q1 : 1
			const q2 = typeof thresholds.q2 === "number" ? thresholds.q2 : Math.max(q1 + 1, 4)
			const q3 = typeof thresholds.q3 === "number" ? thresholds.q3 : Math.max(q2 + 1, 8)
			if (count <= q1) return 1
			if (count <= q2) return 2
			if (count <= q3) return 3
			return 4
		}

		/**
		 * Stats card values. `longestStreak` / `busiest` are part of the contract,
		 * but older host payloads only ship the raw `days`; derive both when absent
		 * rather than rendering `undefined`.
		 */
		function statsOf(raw, days) {
			const stats = (raw && raw.stats) || {}
			const ordered = days
				.filter((day) => day && typeof day.date === "string")
				.slice()
				.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))
			let sum = 0
			let longest = 0
			let busiest = null
			let run = 0
			let previous = null
			for (const day of ordered) {
				const count = typeof day.count === "number" ? day.count : 0
				sum += count
				const current = parseDayKey(day.date)
				if (current) {
					if (previous && dayKey(addDays(previous, 1)) === dayKey(current)) run += 1
					else run = 1
					if (run > longest) longest = run
					previous = current
				}
				if (!busiest || count > busiest.count) busiest = { date: day.date, count: count }
			}
			return {
				commits: typeof stats.commitCountMine === "number" ? stats.commitCountMine : sum,
				activeDays: typeof stats.dayCount === "number" ? stats.dayCount : ordered.length,
				longestStreak: typeof stats.longestStreak === "number" ? stats.longestStreak : longest,
				busiest: stats.busiest && stats.busiest.date ? stats.busiest : busiest,
				repoCount: typeof stats.repoCount === "number" ? stats.repoCount : 0,
				maxPerDay: typeof stats.maxPerDay === "number" ? stats.maxPerDay : busiest ? busiest.count : 0,
			}
		}

		/**
		 * Turn the host Model into the render tree: 53 columns of 7 cells, month
		 * anchors, per-day commit lookup and the stats card values.
		 * `days` carries only non-zero days, so empty cells are synthesised here.
		 * @param raw - the Model envelope payload.
		 * @param today - the reference day for the rolling window.
		 */
		function buildModel(raw, today) {
			const monthsAhead = WEEK_COUNT
			const window = buildWindow(today, monthsAhead)
			const todayNoon = addDays(today, 0)
			const dayByKey = new Map()
			const days = raw && Array.isArray(raw.days) ? raw.days : []
			for (const day of days) {
				if (day && typeof day.date === "string") dayByKey.set(day.date, day)
			}
			const repoName = new Map()
			const repos = raw && Array.isArray(raw.repos) ? raw.repos : []
			for (const repo of repos) {
				if (repo && repo.id) repoName.set(repo.id, repo.name || repo.id)
			}
			const commitsByDay = new Map()
			const commits = raw && Array.isArray(raw.commits) ? raw.commits : []
			for (const commit of commits) {
				if (!commit) continue
				let key = typeof commit.day === "string" ? commit.day : ""
				if (!key && typeof commit.at === "number") key = dayKey(new Date(commit.at * 1000))
				if (!key) continue
				const bucket = commitsByDay.get(key)
				if (bucket) bucket.push(commit)
				else commitsByDay.set(key, [commit])
			}
			for (const bucket of commitsByDay.values()) {
				bucket.sort((left, right) => (right.at || 0) - (left.at || 0))
			}
			const thresholds = (raw && raw.stats && raw.stats.levelThresholds) || {}
			const weeks = []
			const monthAnchors = []
			const cellByKey = new Map()
			for (let week = 0; week < monthsAhead; week += 1) {
				const column = []
				let monthLabel = ""
				for (let row = 0; row < 7; row += 1) {
					const date = addDays(window.first, week * 7 + row)
					const key = dayKey(date)
					const entry = dayByKey.get(key)
					const count = entry && typeof entry.count === "number" ? entry.count : 0
					const future = date.getTime() > todayNoon.getTime()
					const cell = {
						key: key,
						date: date,
						count: count,
						level: levelOf(entry, count, thresholds),
						future: future,
						repos: entry && entry.repos ? entry.repos : null,
					}
					column.push(cell)
					cellByKey.set(key, cell)
					// A month label belongs only to a real 1st of the month; the
					// week's first-appearance heuristic mislabels the leading tail.
					if (!monthLabel && !future && date.getDate() === 1) {
						monthLabel = date.getMonth() + 1 + "月"
					}
				}
				weeks.push(column)
				monthAnchors.push(monthLabel)
			}
			return {
				weeks: weeks,
				monthAnchors: monthAnchors,
				cellByKey: cellByKey,
				repoName: repoName,
				commitsByDay: commitsByDay,
				stats: statsOf(raw, days),
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

		/** Repo names that contributed on one day, largest count first. */
		function repoLabelsFor(day, model, limit) {
			const found = []
			const counts = day.repos || {}
			for (const id of Object.keys(counts)) {
				found.push({ name: model.repoName.get(id) || id, count: counts[id] || 0 })
			}
			if (!found.length) {
				const seen = new Set()
				for (const commit of model.commitsByDay.get(day.key) || []) {
					const name = model.repoName.get(commit.repoId) || commit.repoId || "未知仓库"
					if (seen.has(name)) continue
					seen.add(name)
					found.push({ name: name, count: 1 })
				}
			}
			found.sort((left, right) => right.count - left.count)
			return found.slice(0, limit).map((item) => item.name)
		}

		/** The 53×7 grid: Monday-first rows, columns flow left to right. */
		function HeatmapGrid({ model, selectedKey, onHover, onLeave, onSelect }) {
			const cells = []
			model.weeks.forEach((column, weekIndex) => {
				column.forEach((day, rowIndex) => {
					const selected = selectedKey === day.key
					cells.push(
						h(
							"button",
							{
								key: day.key,
								type: "button",
								className: "ghm-cell",
								"data-l": String(day.level),
								"data-future": day.future ? "1" : "0",
								"data-selected": selected ? "1" : "0",
								"data-week": String(weekIndex + 1),
								"data-row": String(rowIndex),
								tabIndex: day.future ? -1 : 0,
								"aria-label": day.key + " · " + day.count + " 次提交",
								"aria-pressed": selected ? "true" : "false",
								onMouseEnter: (event) => onHover(day, event.currentTarget),
								onMouseLeave: onLeave,
								onFocus: (event) => onHover(day, event.currentTarget),
								onBlur: onLeave,
								onClick: () => onSelect(day.key),
							},
						),
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

		/** Hovering a cell only changes the tooltip, so the 371 cells stay put. */
		const MemoGrid = React.memo(HeatmapGrid)

		/** Self-drawn hover card (the native `title` has a ~1s delay and no wraps). */
		function Tooltip({ tip, model }) {
			if (!tip) return null
			const day = tip.day
			const names = repoLabelsFor(day, model, 2)
			return h(
				"div",
				{
					className: "ghm-tip",
					role: "tooltip",
					style: { left: tip.x + "px", top: tip.y + "px" },
				},
				h("div", { className: "ghm-tip-k" }, day.key + " · " + day.count + " 次提交"),
				names.length ? h("div", { className: "ghm-tip-r" }, names.join("、")) : null,
			)
		}

		/** Commits of the clicked day: subject + 7-char sha + repo name. */
		function DayDetail({ model, selectedKey, onClose }) {
			const cell = model.cellByKey.get(selectedKey)
			const commits = model.commitsByDay.get(selectedKey) || []
			const count = cell ? cell.count : commits.length
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
				)
			})
			return h(
				"div",
				{ className: "ghm-card" },
				h(
					"div",
					{ className: "ghm-detail-head" },
					h("div", { className: "ghm-card-title", style: { marginBottom: 0 } }, selectedKey + " · " + count + " 次提交"),
					h("span", { className: "ghm-muted" }, "点同一格可取消选择"),
					h("span", { className: "ghm-grow" }),
					h("button", { className: "ghm-btn", type: "button", onClick: onClose }, "取消选择"),
				),
				rows.length
					? h("div", { className: "ghm-commits" }, rows)
					: h("div", { className: "ghm-muted" }, "这一天没有提交。"),
			)
		}

		/** The `main`-slot page. */
		function HeatmapPage() {
			const [state, setState] = React.useState({ phase: "loading", value: null, error: null })
			const [tip, setTip] = React.useState(null)
			const [selectedKey, setSelectedKey] = React.useState(null)

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

			const model = React.useMemo(() => {
				if (!state.value) return null
				return buildModel(state.value, new Date())
			}, [state.value])

			const busy = state.phase === "loading" || state.phase === "refreshing"
			const handleHover = React.useCallback((day, element) => {
				if (!day || day.future) return
				const rect = element.getBoundingClientRect()
				setTip({ day: day, x: rect.left + rect.width / 2, y: rect.top - 8 })
			}, [])
			const handleLeave = React.useCallback(() => setTip(null), [])
			const handleSelect = React.useCallback((key) => {
				setSelectedKey((previous) => (previous === key ? null : key))
			}, [])
			const handleKeyDown = React.useCallback((event) => {
				if (event.key === "Escape") setSelectedKey(null)
			}, [])

			const raw = state.value
			const badge = raw
				? [raw.stage || "M2", raw.cached === true ? "缓存" : "实时", typeof raw.elapsedMs === "number" ? raw.elapsedMs + "ms" : null]
						.filter(Boolean)
						.join(" · ")
				: "M2 · 本地 git"

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
			} else if (!model || model.stats.commits === 0) {
				const repoCount = model ? model.stats.repoCount : 0
				body = h(
					"div",
					{ className: "ghm-card" },
					h(
						"div",
						{ className: "ghm-state" },
						h("div", { className: "ghm-state-t" }, "还没有可绘制的提交"),
						h("div", { className: "ghm-note" }, "本机 " + repoCount + " 个仓库 · 窗口内没有扫描到本人提交。"),
						h("div", { className: "ghm-note" }, "可能原因：扫描中 / 未扫描到仓库 / 窗口内确实没有提交。"),
						h(
							"button",
							{ className: "ghm-btn", type: "button", onClick: () => load(true), disabled: busy },
							"重新扫描",
						),
					),
				)
			} else {
				const stats = model.stats
				const busiest = stats.busiest
				body = h(
					React.Fragment,
					null,
					h(
						"div",
						{ className: "ghm-stats" },
						h(StatCard, { key: "commits", label: "总提交", value: String(stats.commits), hint: "仅本人邮箱提交" }),
						h(StatCard, { key: "days", label: "活跃天数", value: String(stats.activeDays), hint: "至少 1 次提交" }),
						h(StatCard, { key: "streak", label: "最长连续", value: stats.longestStreak + " 天", hint: "按自然日衔接" }),
						h(StatCard, {
							key: "busiest",
							label: "最忙一天",
							value: busiest ? busiest.count + " 次" : "—",
							hint: busiest ? busiest.date : "窗口内无提交",
						}),
					),
					state.error
						? h(
								"div",
								{ className: "ghm-card" },
								h("div", { className: "ghm-warn" }, "刷新失败：" + state.error.code + " · " + state.error.message + "（显示上次结果）"),
							)
						: null,
					h(
						"div",
						{ className: "ghm-card" },
						h(
							"div",
							{ className: "ghm-card-title" },
							"近 " + WEEK_COUNT + " 周贡献",
							h("span", { className: "ghm-muted" }, "周一 → 周日 · " + WEEK_COUNT * 7 + " 格"),
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
						),
						h(
							"div",
							{ className: "ghm-note" },
							"本机 " + stats.repoCount + " 个仓库 · 仅统计本人邮箱提交 · 时区 " + model.timezone,
						),
					),
					selectedKey ? h(DayDetail, { model: model, selectedKey: selectedKey, onClose: () => setSelectedKey(null) }) : null,
					h(Tooltip, { tip: tip, model: model }),
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
					h("span", { className: "ghm-grow" }),
					h(
						"button",
						{ className: "ghm-btn", type: "button", onClick: () => load(true), disabled: busy },
						busy ? "刷新中…" : "刷新",
					),
				),
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
		return module.exports
	},
})
