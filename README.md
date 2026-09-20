# jev-context

A context governor for [Pi](https://github.com/earendil-works/pi-mono) coding agent sessions,
driven by [TypeSafe](https://docs.typesafe.ai)'s Jev — a System One model that returns typed
judgments with calibrated probabilities instead of generating text.

Pi sessions accumulate context: every skill description, every tool schema, every dead-end
tool output. This extension moves three decisions off the main model's attention and onto a
cheap, fast, purpose-built judge:

1. **Skill routing** — at each user turn, Jev scores every installed skill's full body against
   a digest of the conversation (user turns + assistant text/thinking, tool I/O excluded,
   newest-first, budgeted). Skills passing threshold (default 0.6, top-3) are injected into
   context; the rest of the catalog stays out. Loaded skills are never re-scored; a decay
   re-check (every 5th turn, floor 0.25) evicts stale ones.
2. **Tool surfacing** — tool namespaces you configure (e.g. `browser_*`, `tavily_*`) are
   scored in one batched call per turn and only surfaced when relevant. A hardcoded core
   (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) is always on. If the model ever
   calls a surfaced-off tool, the miss is detected and the namespace returns at the next
   turn boundary.
3. **Epoch pruning** — when an agent turn settles, Jev judges each tool call/result pair of
   that turn: "given how the turn concluded, is this output helpful to subsequent turns?"
   Dead pairs are removed from the context copy (reasoning and text are kept; the on-disk
   transcript is never touched). Judgments are memoized by message id; nothing is re-judged.

On the authors' own session corpus the harness in `eval/` measures roughly a third of context
tokens saved; your mileage will vary, and the harness exists precisely so you can measure it
on your own logs.

## Install

```sh
# symlink or copy into Pi's extension directory
ln -s "$PWD/extensions/jev-context.ts" ~/.pi/agent/extensions/jev-context.ts
```

Then configure (all fields optional; defaults shown):

```jsonc
// ~/.pi/agent/jev-context.json
{
  "apiKeyEnv": "PI_TYPESAFE_JEV",        // env var holding the TypeSafe key…
  "apiKeyFile": "~/.pi/agent/secrets/typesafe-jev.key", // …or a raw-key file (chmod 600)
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "model": "jev-latest",
  "loadThreshold": 0.6,                  // skill load threshold
  "topK": 3,                             // max skills loaded per turn
  "decayThreshold": 0.25,                // eviction floor on decay re-checks
  "decayIntervalTurns": 5,
  "digestCapBytes": 80000,
  "pruneThreshold": 0.2,                 // prune when helpful-score ≤ this
  "consoleLog": false,                   // true = echo judgment lines to stderr
  "toolNamespaces": {                    // owner-configured bundles; none shipped
    "browser": { "prefix": "browser_" },
    "search": { "tools": ["tavily_search", "tavily_extract"] }
  },
  "coreTools": ["read", "write", "edit", "bash", "grep", "find", "ls"]
}
```

Skill discovery scans Pi's canonical skill roots (`~/.pi/agent/skills`, `~/.agents/skills`,
project `.pi/skills` / `.agents/skills`); add more via `skillRoots`. A project-level
`<cwd>/.pi/jev-context.json` overrides the user-level config.

Telemetry lands in `~/.pi/agent/jev-context-telemetry.jsonl` (structured `ROUTE_DECISION`,
`TOOL_SURFACE`, `PRUNE_JUDGED`, `PRUNE_EPOCH`, `ROUTE_DEGRADED` events). `/skill_stats`
renders aggregates in-session; `/skill:<name>` force-loads and pins a skill manually.

## Data handling

Judging sends conversation digests and tool outputs to the configured TypeSafe endpoint over
HTTPS. Nothing else leaves the machine, the key is never logged, and the on-disk session
transcript is never modified. If Jev is unreachable or unconfigured, the extension degrades
loudly to Pi's native behavior (all skills visible per Pi defaults, no pruning).

## Development

Zero runtime dependencies; erasable TypeScript run under Node strip-types; `node:test`.

```sh
npm install --ignore-scripts
npm run check   # biome (zero warnings) + tsgo (erasableSyntaxOnly) + pinned-deps + eval gate
npm test        # node --test, no network
```

`VERIFYING.md` is the binding quality contract (gates, invariants, ratchets, behavior specs).
The `eval/` harness replays Pi session JSONL through the three nozzles and reports
counterfactual token reduction — see `eval/README.md`. Corpora are owner-local and never
committed.

## License

MIT
