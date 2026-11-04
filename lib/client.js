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
		const NS = "git-heatmap"

		// ---------------------------------------------------------------- styles

		const CSS = `
.ghm-page { display: flex; flex-direction: column; gap: 18px; padding: 24px 28px; height: 100%; overflow: auto; box-sizing: border-box; }
.ghm-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ghm-title { margin: 0; font-size: 19px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.ghm-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #d5d9e0); color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-card { border: 1px solid var(--dsw-alias-border-l1, #e5e8ee); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #ffffff); padding: 14px 16px; }
.ghm-card-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #5a6272); margin-bottom: 8px; letter-spacing: .02em; }
.ghm-kv { display: grid; grid-template-columns: max-content 1fr; gap: 5px 14px; font-size: 12.5px; }
.ghm-k { color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-v { color: var(--dsw-alias-label-primary, #1f2329); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
.ghm-ok { color: var(--dsw-alias-state-success-primary, #2da44e); font-weight: 600; }
.ghm-bad { color: var(--dsw-alias-state-error-primary, #d1242f); font-weight: 600; }
.ghm-gridwrap { display: flex; gap: 8px; align-items: flex-start; overflow-x: auto; padding-bottom: 4px; }
.ghm-weekdays { display: grid; grid-template-rows: repeat(7, 11px); gap: 3px; font-size: 9px; line-height: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1); text-align: right; padding-top: 18px; }
.ghm-grid { --ghm-0: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 8%, transparent);
            --ghm-1: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2da44e) 22%, transparent);
            --ghm-2: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2da44e) 42%, transparent);
            --ghm-3: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2da44e) 68%, transparent);
            --ghm-4: var(--dsw-alias-state-success-primary, #2da44e);
            display: grid; grid-template-rows: repeat(7, 11px); grid-auto-flow: column; grid-auto-columns: 11px; gap: 3px; margin-top: 18px; }
.ghm-cell { width: 11px; height: 11px; border-radius: 2.5px; background: var(--ghm-0); }
.ghm-cell[data-l="1"] { background: var(--ghm-1); }
.ghm-cell[data-l="2"] { background: var(--ghm-2); }
.ghm-cell[data-l="3"] { background: var(--ghm-3); }
.ghm-cell[data-l="4"] { background: var(--ghm-4); }
.ghm-foot { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.ghm-legend { display: inline-flex; align-items: center; gap: 3px; }
.ghm-legend span.ghm-cell { display: inline-block; }
.ghm-note { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b93a1); margin-top: 6px; }
.ghm-btn { font-size: 12px; padding: 4px 12px; border-radius: 7px; cursor: pointer;
           border: 1px solid var(--dsw-alias-border-l2, #d5d9e0); background: var(--dsw-alias-bg-layer-2, #f5f6f8);
           color: var(--dsw-alias-label-primary, #1f2329); }
.ghm-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #eceef2); }
.ghm-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
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
		 * (no leading slash): the GUI is served with `<base href="./">`, so a
		 * root-absolute path escapes a sub-path deployment prefix.
		 * @param path - route path, e.g. "git-heat/probe".
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

		/** One line of the probe card. */
		function KV({ label, value, tone }) {
			return [
				h("div", { key: "k", className: "ghm-k" }, label),
				h("div", { key: "v", className: "ghm-v" + (tone ? " " + tone : "") }, value),
			]
		}

		/** The 53×7 grid. M1 renders every cell empty; M3 binds real counts. */
		function EmptyGrid({ weeks }) {
			const cells = []
			for (let index = 0; index < weeks * 7; index += 1) {
				cells.push(h("div", { key: index, className: "ghm-cell", "data-l": "0" }))
			}
			return h(
				"div",
				{ className: "ghm-gridwrap" },
				h(
					"div",
					{ className: "ghm-weekdays" },
					["", "一", "", "三", "", "五", ""].map((text, index) => h("div", { key: index }, text)),
				),
				h("div", { className: "ghm-grid" }, cells),
			)
		}

		/** The `main`-slot page. */
		function HeatmapPage() {
			const [probe, setProbe] = React.useState({ state: "loading" })
			const weekCount = 53

			const runProbe = React.useCallback(() => {
				setProbe({ state: "loading" })
				post("git-heat/probe", {}).then((result) => {
					if (result.ok) setProbe({ state: "done", value: result.value })
					else setProbe({ state: "error", error: result.error })
				})
			}, [])

			React.useEffect(() => {
				runProbe()
			}, [runProbe])

			let probeBody
			if (probe.state === "loading") {
				probeBody = h("div", { className: "ghm-note" }, "探测中…")
			} else if (probe.state === "error") {
				probeBody = h(
					"div",
					{ className: "ghm-kv" },
					h("div", { key: "k", className: "ghm-k" }, "路由"),
					h("div", { key: "v", className: "ghm-v ghm-bad" }, probe.error.code + " · " + probe.error.message),
				)
			} else {
				const value = probe.value
				probeBody = h(
					"div",
					{ className: "ghm-kv" },
					KV({
						label: "宿主 spawn git",
						value: value.spawnOk ? "成功" : "失败",
						tone: value.spawnOk ? "ghm-ok" : "ghm-bad",
					}),
					KV({ label: "git 版本", value: value.gitVersion ?? "—" }),
					KV({ label: "退出码", value: String(value.exitCode) }),
					KV({ label: "耗时", value: value.elapsedMs + " ms" }),
					KV({ label: "argv[0]", value: value.argv0 }),
					KV({ label: "宿主 cwd", value: value.cwd }),
					value.stderr ? KV({ label: "stderr", value: value.stderr }) : null,
				)
			}

			return h(
				"div",
				{ className: "ghm-page", "data-dsh-plugin": "git-heatmap" },
				h(
					"div",
					{ className: "ghm-head" },
					h("h1", { className: "ghm-title" }, "Git 热力图"),
					h("span", { className: "ghm-badge" }, "M1 · 空壳"),
				),
				h(
					"div",
					{ className: "ghm-card" },
					h("div", { className: "ghm-card-title" }, "M0 · 宿主进程 git 探测"),
					probeBody,
					h(
						"div",
						{ style: { marginTop: "10px" } },
						h("button", { className: "ghm-btn", type: "button", onClick: runProbe }, "重新探测"),
					),
				),
				h(
					"div",
					{ className: "ghm-card" },
					h("div", { className: "ghm-card-title" }, "网格几何（" + weekCount + " 周 × 7 天 = " + weekCount * 7 + " 格）"),
					h(EmptyGrid, { weeks: weekCount }),
					h(
						"div",
						{ className: "ghm-foot" },
						h("span", null, "少"),
						h(
							"span",
							{ className: "ghm-legend" },
							[0, 1, 2, 3, 4].map((level) =>
								h("span", { key: level, className: "ghm-cell", "data-l": String(level) }),
							),
						),
						h("span", null, "多"),
						h("span", { style: { marginLeft: "10px" } }, "数据层未接入：全部格子为空"),
					),
				),
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
