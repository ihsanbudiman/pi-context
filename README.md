# pi-context-breakdown

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that adds a `/context` command showing a zcode-style breakdown of what's using your context window:

```
Context: 26.3k tokens
  Messages      43.4%
  Tools         53.2%
    - built-in  13.5%
    - MCP        3.1%   (mcp, mcp__github, mcp__atlassian)
    - extension 36.6%   (casefile/xpi, subagent, …)
  System prompt  2.4%  (context files, tool snippets, guidelines)
```

In a TUI session the breakdown opens as a dismissable panel (any key closes it); otherwise it renders as a widget above the editor (`/context off` clears it).

## Usage

- `/context` — compact breakdown (default): percentages of total context tokens per category
- `/context full` — full breakdown: adds token counts, message sub-parts (user / assistant / tool results), built-in tool names, and every system-prompt sub-part
- `/context off` — clear the widget

## Install

```sh
pi install git:github.com/ihsanbudiman/pi-context
```

Or copy `index.ts` into `~/.pi/agent/extensions/context-breakdown.ts`.

## How it works

- Snapshots the structured system prompt (tool snippets, guidelines, context files, skills) on every `before_agent_start`.
- Captures the final serialized provider payload on `before_provider_request` and splits the `tools` array into built-in, MCP (`mcp`/`mcp__*`), and extension-registered by name.
- Estimates tokens as chars/4 — no tokenizer dependency — then rescales all categories to match the context usage shown in pi's footer when known (`ctx.getContextUsage()`).

Percentages are of total context tokens. Before any assistant response in a fresh session the number is a raw chars/4 estimate.

## License

MIT
