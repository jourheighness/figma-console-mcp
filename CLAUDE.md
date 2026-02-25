# Project Rules

## Code Exploration — HARD RULE

**Always use Serena and GrepAI as primary tools for all code exploration, reading, and search.** Do not use Read, Grep, or Glob on source files unless strictly necessary (non-code files, small configs, or when symbol boundaries don't apply).

### Serena — structural/symbolic navigation (use first for precise lookups)
1. `get_symbols_overview` or `find_symbol` to discover structure
2. `find_symbol` with `include_body=True` to read specific symbols
3. `find_referencing_symbols` to trace usage
4. `search_for_pattern` for text/regex when symbol names are unknown
5. `replace_symbol_body` / `insert_after_symbol` / `insert_before_symbol` for symbolic edits
6. `insert_at_line` / `delete_lines` for line-level edits when symbol boundaries don't fit

### GrepAI — semantic search (use for discovery and fuzzy questions)
1. `grepai_search` for natural-language queries ("how does X work", "where is Y handled")
2. `grepai_trace_callers` / `grepai_trace_callees` for call graph traversal
3. `grepai_trace_graph` for full dependency analysis around a symbol
4. Always use `format: "toon"` to minimize token usage

### Decision matrix
| Need | Tool |
|-|-|
| Find a specific symbol by name | Serena `find_symbol` |
| Read a function/class body | Serena `find_symbol` + `include_body` |
| "Where is X used?" | Serena `find_referencing_symbols` |
| "How does feature X work?" | GrepAI `grepai_search` |
| "What calls this function?" | GrepAI `grepai_trace_callers` |
| Regex/text pattern search | Serena `search_for_pattern` |
| Read non-code file (JSON, MD, config) | Read tool (fallback) |

### Fallback rules
- Only use Read for non-code files, or after Serena/GrepAI confirm you need the full file
- Only use Grep/Glob when neither Serena nor GrepAI can answer the question
- Never read an entire source file as a first action — always start with Serena or GrepAI

## Tool Quality — HARD RULE

**When modifying any MCP tool (registration, schema, bridge handler, or connector method), you MUST review and update its LLM-facing surface before considering the work done.** These tools are consumed by LLM agents, not humans — clarity and completeness in descriptions directly determine whether the tool gets used correctly.

Checklist for every tool change:
1. **Tool description** (`server.tool()` string): Does it explain what changed? Does it cover edge cases, valid input types, and common pitfalls? Would an LLM with no prior context use this tool correctly on first try?
2. **Parameter descriptions** (`.describe()` on each Zod field): Are they accurate after the change? Do they document valid values, defaults, and interactions with other params?
3. **Error messages** (bridge handlers, connector methods): Are they actionable? Do they tell the agent what went wrong AND what to do next?
4. **Search result hints** (library cache, find_components responses): Do returned objects include enough context for the agent to know how to use them in the next step?
5. **Server instructions** (`src/local.ts` tool documentation block): Update if the tool's workflow, capabilities, or limitations changed.

If you add a new code path (e.g., componentSet key support), the description must mention it. If you deprecate behavior, the description must warn about it. Silent capabilities are useless to LLM consumers.
