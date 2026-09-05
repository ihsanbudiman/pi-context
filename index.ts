/**
 * pi extension: /context — zcode-style context usage breakdown.
 *
 * Repo: https://github.com/ihsanbudiman/pi-context
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write"]);
const CHARS_PER_TOKEN = 4;

type ToolSplit = { builtin: number; mcp: number; ext: number; mcpNames: string[]; extNames: string[] };

type Snapshot = {
	messagesChars: number;
	sysChars: number;
	tools: ToolSplit;
	sysParts: Array<{ name: string; chars: number }>;
};

/** chars -> tokens, chars/4 heuristic */
const est = (chars: number) => chars / CHARS_PER_TOKEN;

const isMcpTool = (name: string) => /^mcp($|__)/.test(name);

function splitTools(tools: unknown[]): ToolSplit {
	const split: ToolSplit = { builtin: 0, mcp: 0, ext: 0, mcpNames: [], extNames: [] };
	for (const tool of tools) {
		const t = tool as { name?: string; function?: { name?: string } };
		const name = t?.name ?? t?.function?.name ?? "";
		const chars = JSON.stringify(tool).length;
		if (isMcpTool(name)) {
			split.mcp += chars;
			split.mcpNames.push(name);
		} else if (BUILTIN_TOOLS.has(name)) {
			split.builtin += chars;
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
	let sys: Snapshot["sysParts"] & Array<{ name: string; chars: number }> = [];
	let snap: Snapshot | null = null;

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
		const tools = Array.isArray(payload.tools) ? payload.tools : [];
		snap = {
			messagesChars: messages.reduce((n: number, m) => n + JSON.stringify(m).length, 0),
			sysChars: measureSystem(payload),
			tools: splitTools(tools),
			sysParts: sys,
		};
	});

	pi.registerCommand("context", {
		description: "Show context usage breakdown",
		handler: async (args, ctx) => {
			if (args?.trim() === "off") {
				ctx.ui.setWidget("context-breakdown", undefined);
				return;
			}
			if (!snap) {
				ctx.ui.notify("No provider request seen yet — send a message first.", "warning");
				return;
			}

			// 3. chars/4 estimate, calibrated against the footer's context usage when known
			const raw = {
				messages: est(snap.messagesChars),
				builtin: est(snap.tools.builtin),
				mcp: est(snap.tools.mcp),
				ext: est(snap.tools.ext),
				sys: est(snap.sysChars),
			};
			const estTotal = Object.values(raw).reduce((a, b) => a + b, 0);
			const usage = ctx.getContextUsage();
			const scale = usage?.tokens && estTotal > 0 ? usage.tokens / estTotal : 1;
			const t = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v * scale]));
			const total = Object.values(t).reduce((a, b) => a + b, 0);

			const toolTotal = t.builtin + t.mcp + t.ext;
			const topSys = snap.sysParts.filter((p) => p.chars > 0).sort((a, b) => b.chars - a.chars).slice(0, 3).map((p) => p.name);
			const lines = [
				`Context: ${fmtK(total)} tokens${usage?.tokens ? "" : " (estimate)"}`,
				`  Messages      ${pct(t.messages, total)}%`,
				`  Tools         ${pct(toolTotal, total)}%`,
				`    - built-in  ${pct(t.builtin, total)}%`,
				`    - MCP       ${pct(t.mcp, total)}%   (${clip(snap.tools.mcpNames)})`,
				`    - extension ${pct(t.ext, total)}%   (${clip(snap.tools.extNames)})`,
				`  System prompt ${pct(t.sys, total)}%  (${topSys.join(", ") || "none"})`,
			];

			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
					const panel = new Text(lines.join("\n"), 1, 1);
					return {
						render: (width: number) => panel.render(width),
						invalidate: () => {},
						handleInput: (data: string) => {
							if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "space")) done();
						},
					};
				});
			} else {
				ctx.ui.setWidget("context-breakdown", lines);
				ctx.ui.notify("Breakdown shown as widget (/context off to clear).", "info");
			}
		},
	});
}
