/**
 * pi extension: /context — zcode-style context usage breakdown.
 *
 * /context        compact breakdown (default)
 * /context full   full breakdown with token counts and sub-parts
 * /context off    clear the widget (non-TUI fallback)
 *
 * Repo: https://github.com/ihsanbudiman/pi-context
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write"]);
const CHARS_PER_TOKEN = 4;

const CONFIG_FILE = join(homedir(), ".pi", "agent", "context-breakdown.json");

type ToolSplit = {
	builtin: number;
	mcp: number;
	ext: number;
	builtinNames: string[];
	mcpNames: string[];
	extNames: string[];
};

type Snapshot = {
	messageChars: { user: number; assistant: number; other: number };
	messagesChars: number;
	sysChars: number;
	tools: ToolSplit;
	sysParts: Array<{ name: string; chars: number }>;
};

/** chars -> tokens, chars/4 heuristic */
const est = (chars: number) => chars / CHARS_PER_TOKEN;

const isMcpTool = (name: string) => /^mcp($|__)/.test(name);

function splitTools(tools: unknown[]): ToolSplit {
	const split: ToolSplit = { builtin: 0, mcp: 0, ext: 0, builtinNames: [], mcpNames: [], extNames: [] };
	for (const tool of tools) {
		const t = tool as { name?: string; function?: { name?: string } };
		const name = t?.name ?? t?.function?.name ?? "";
		const chars = JSON.stringify(tool).length;
		if (isMcpTool(name)) {
			split.mcp += chars;
			split.mcpNames.push(name);
		} else if (BUILTIN_TOOLS.has(name)) {
			split.builtin += chars;
			split.builtinNames.push(name);
		} else {
			split.ext += chars;
			if (name) split.extNames.push(name);
		}
	}
	return split;
}

function measureSystem(payload: Record<string, unknown>): number {
	const sys = payload.system;
	if (typeof sys === "string") return sys.length;
	if (Array.isArray(sys)) return sys.reduce((n: number, b: { text?: string }) => n + (b?.text?.length ?? 0), 0);
	if (typeof payload.instructions === "string") return payload.instructions.length;
	return 0;
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pct = (part: number, total: number) => (total > 0 ? `${((part / total) * 100).toFixed(1)}`.padStart(5) : "  0.0");
const clip = (names: string[], max = 46) => {
	const s = names.join(", ");
	return s.length > max ? `${s.slice(0, max)}…` : s;
};

export default function (pi: ExtensionAPI) {
	let sys: Array<{ name: string; chars: number }> = [];
	let snap: Snapshot | null = null;
	// Persisted display mode (compact default), survives sessions and restarts
	let mode: "compact" | "full" = "compact";
	try {
		if (existsSync(CONFIG_FILE)) {
			const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { mode?: string };
			if (saved.mode === "full" || saved.mode === "compact") mode = saved.mode;
		}
	} catch {}

	// 1. System prompt + sub-categories, snapshotted per run
	pi.on("before_agent_start", async (event) => {
		const o = event.systemPromptOptions ?? {};
		const jsonLen = (v: unknown) => (v === undefined ? 0 : JSON.stringify(v).length);
		sys = [
			{ name: "tool snippets", chars: jsonLen(Object.values(o.toolSnippets ?? {})) },
			{ name: "guidelines", chars: jsonLen(o.promptGuidelines) },
			{ name: "context files", chars: (o.contextFiles ?? []).reduce((n, f) => n + f.content.length, 0) },
			{ name: "skills", chars: jsonLen(o.skills) },
			{ name: "custom prompt", chars: (o.customPrompt ?? "").length + (o.appendSystemPrompt ?? "").length },
		];
	});

	// 2. Final serialized provider payload
	pi.on("before_provider_request", (event) => {
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const byRole = { user: 0, assistant: 0, other: 0 };
		let messagesChars = 0;
		for (const m of messages) {
			const chars = JSON.stringify(m).length;
			messagesChars += chars;
			const role = (m as { role?: string }).role;
			if (role === "user") byRole.user += chars;
			else if (role === "assistant") byRole.assistant += chars;
			else byRole.other += chars;
		}
		snap = {
			messageChars: byRole,
			messagesChars,
			sysChars: measureSystem(payload),
			tools: splitTools(Array.isArray(payload.tools) ? payload.tools : []),
			sysParts: sys,
		};
	});

	pi.registerCommand("context", {
		description: "Show context usage breakdown (/context full|compact|off|reset)",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";
			if (arg === "off") {
				ctx.ui.setWidget("context-breakdown", undefined);
				return;
			}
			if (arg === "reset") {
				try {
					unlinkSync(CONFIG_FILE);
				} catch {}
				mode = "compact";
				ctx.ui.setWidget("context-breakdown", undefined);
				ctx.ui.notify("context-breakdown: config cleared, mode reset to compact.", "info");
				return;
			}
			if (arg === "full" || arg === "compact") {
				mode = arg;
				try {
					writeFileSync(CONFIG_FILE, JSON.stringify({ mode }));
				} catch {}
			}
			if (!snap) {
				ctx.ui.notify("No provider request seen yet — send a message first.", "warning");
				return;
			}
			const full = mode === "full";

			// 3. chars/4 estimate, calibrated against the footer's context usage when known.
			// Top-level categories only — sub-parts (msg:*, sys:*) are contained in their
			// parents and must not be summed into the total.
			const sysPartSum = snap.sysParts.reduce((n, p) => n + est(p.chars), 0);
			const raw: Record<string, number> = {
				messages: est(snap.messagesChars),
				builtin: est(snap.tools.builtin),
				mcp: est(snap.tools.mcp),
				ext: est(snap.tools.ext),
				// Some providers don't expose the system prompt in the serialized payload;
				// take the larger of the payload measurement and the known sub-parts.
				sys: Math.max(est(snap.sysChars), sysPartSum),
			};
			const estTotal = Object.values(raw).reduce((a, b) => a + b, 0);
			const usage = ctx.getContextUsage();
			const scale = usage?.tokens && estTotal > 0 ? usage.tokens / estTotal : 1;
			const t = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v * scale]));
			const msgUnit = t.messages / (est(snap.messagesChars) || 1);
			t["msg:user"] = est(snap.messageChars.user) * msgUnit;
			t["msg:assistant"] = est(snap.messageChars.assistant) * msgUnit;
			t["msg:other"] = est(snap.messageChars.other) * msgUnit;
			for (const p of snap.sysParts) t[`sys:${p.name}`] = (est(p.chars) / (sysPartSum || 1)) * t.sys;
			const total = t.messages + t.builtin + t.mcp + t.ext + t.sys;
			const toolTotal = t.builtin + t.mcp + t.ext;
			const cal = (n: number) => `${fmtK(n)} ${pct(n, total)}%`;

			const row = (label: string, tokens: number, names?: string[]) =>
				`  ${label.padEnd(18)}${full ? cal(tokens).padEnd(14) : `${pct(tokens, total)}%`}${names?.length ? `  (${clip(names)})` : ""}`;
			const sub = (label: string, tokens: number, names?: string[]) =>
				`    - ${label.padEnd(14)}${full ? cal(tokens).padEnd(14) : `${pct(tokens, total)}%`}${names?.length ? `  (${clip(names)})` : ""}`;

			const topSys = snap.sysParts
				.filter((p) => p.chars > 0)
				.sort((a, b) => b.chars - a.chars)
				.slice(0, 3)
				.map((p) => p.name);

			// Cumulative provider-reported usage across the whole session
			let lastReq: string | null = null;
			try {
				let input = 0, out = 0, read = 0, write = 0, requests = 0;
				for (const entry of ctx.sessionManager.getBranch()) {
					const m = (entry as { message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } }).message;
					if (m?.role === "assistant" && m.usage) {
						input += m.usage.input ?? 0;
						out += m.usage.output ?? 0;
						read += m.usage.cacheRead ?? 0;
						write += m.usage.cacheWrite ?? 0;
						requests++;
					}
				}
				if (requests > 0) {
					lastReq = `Session (${requests} request${requests > 1 ? "s" : ""}): input ${fmtK(input)} · cached ${fmtK(read)} read / ${fmtK(write)} write · output ${fmtK(out)}`;
				}
			} catch {}

			const lines = [
				`Context: ${fmtK(total)} tokens${usage?.tokens ? "" : " (estimate)"}`,
				row("Messages", t.messages),
				...(full ? [sub("user", t[`msg:user`]), sub("assistant", t[`msg:assistant`]), sub("tool results", t[`msg:other`])] : []),
				row("Tools", toolTotal),
				sub("built-in", t.builtin, full ? snap.tools.builtinNames : undefined),
				sub("MCP", t.mcp, snap.tools.mcpNames),
				sub("extension", t.ext, snap.tools.extNames),
				row("System prompt", t.sys),
				...(full
					? snap.sysParts.filter((p) => p.chars > 0).sort((a, b) => b.chars - a.chars).map((p) => sub(p.name, t[`sys:${p.name}`]))
					: [`    ${topSys.join(", ") || "none"}`]),
				...(lastReq ? [lastReq] : []),
			];

			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
					const panel = new Text(lines.map((l) => l.trimEnd()).join("\n"), 1, 1);
					return {
						render: (width: number) => panel.render(width),
						invalidate: () => {},
						handleInput: (data: string) => {
							done();
							// Forward printable keys typed while the panel was open to the editor
							if (data.length === 1 && data >= " ") ctx.ui.pasteToEditor(data);
						},
					};
				});
			} else {
				ctx.ui.setWidget("context-breakdown", lines.map((l) => l.trimEnd()));
				ctx.ui.notify(`Breakdown shown as widget (/context ${full ? "" : "full, "}off to clear).`, "info");
			}
		},
	});
}
