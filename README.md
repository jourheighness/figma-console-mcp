# figma-console-mcp

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![npm](https://img.shields.io/npm/v/figma-console-mcp)](https://www.npmjs.com/package/figma-console-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Early alpha.** This works, but expect rough edges everywhere. Tool descriptions are patchy, discovery is inconsistent, and many operations have gaps or untested paths. Things will break. If you're here, you're an early adopter — [file issues](https://github.com/southleft/figma-console-mcp/issues), send PRs, or just know what you're getting into.

MCP server + Figma plugin that gives AI agents (Claude Code, Claude Desktop, Cursor, Windsurf) direct access to Figma's Plugin API. Read design tokens, inspect components, create nodes, set styles, manage variables — all through natural language.

No Figma Enterprise plan required for variables/tokens.

## What it can do

- **Read** — file structure, components, variables/tokens, styles, selection, viewport
- **Write** — nodes, fills, strokes, text, layout, effects, variable bindings
- **Create** — component variants, component sets, pages, design token collections
- **Manage** — prototyping reactions, style definitions, instance properties
- **Observe** — console logs, screenshots, selection tracking, viewport awareness

## Requirements

- **Figma Desktop** app (not browser Figma)
- **Node.js** >= 18
- **Figma Personal Access Token** — [get one here](https://www.figma.com/developers/api#access-tokens) (starts with `figd_`)

## Setup

### 1. Clone and build

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
npm run build
```

Or use npx without cloning (less control, but faster):
```bash
npx -y figma-console-mcp@latest
```

### 2. Install the Figma plugin

1. Open **Figma Desktop**
2. **Plugins > Development > Import plugin from manifest...**
3. Select `figma-console-mcp/figma-desktop-bridge/manifest.json`
4. Click **Open**

One-time setup. The plugin stays in your Development plugins list. You only need to re-import the manifest if `manifest.json` itself changes (e.g., new network permissions after a git pull).

### 3. Configure your MCP client

Add to your MCP client config:

**Claude Code (CLI) — one command:**
```bash
claude mcp add figma-console -s user \
  -e FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN \
  -- npx -y figma-console-mcp@latest
```

Or for a local git clone:
```bash
claude mcp add figma-console -s user \
  -e FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN \
  -- node /path/to/figma-console-mcp/dist/local.js
```

**Claude Desktop / Cursor / Windsurf — edit config file:**

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN"
      }
    }
  }
}
```

Config file locations:

| App | macOS | Windows |
|-|-|-|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |

### 4. Run it

1. Open a Figma file in **Figma Desktop**
2. Run the plugin: **Plugins > Development > Figma Desktop Bridge**
3. Wait for "Desktop Bridge active" in the plugin status bar
4. Start your MCP client — it connects automatically via WebSocket

To test: ask your AI assistant *"Check Figma status"* or *"What's selected in Figma?"*

## Environment variables

| Variable | Required | Description |
|-|-|-|
| `FIGMA_ACCESS_TOKEN` | Yes | Personal access token for Figma REST API |
| `FIGMA_DESIGN_SYSTEMS` | No | JSON map of design system names to team IDs: `{"my-ds":"12345"}`. Enables `figma_get_library_components`. |
| `FIGMA_TEAM_ID` | No | Legacy alternative to above. Comma-separated team IDs. |
| `FIGMA_WS_PORT` | No | Preferred WebSocket port (default: 9223, falls back through 9224-9232) |
| `FIGMA_WS_HOST` | No | WebSocket bind host (default: `localhost`) |
| `ENABLE_MCP_APPS` | No | Set `true` to enable experimental interactive MCP Apps |

## Architecture

```
MCP Client (Claude, Cursor, etc.)
    | stdio (MCP protocol)
MCP Server (Node.js)
    | WebSocket (localhost:9223-9232)
Figma Plugin UI (ui.html)
    | postMessage
Figma Plugin Worker (code.js, QuickJS sandbox)
    | figma.* API
Figma Desktop
```

The MCP server also calls the Figma REST API directly for file data, screenshots, and component metadata. The plugin bridge handles everything the REST API can't: variables without Enterprise, live code execution, node manipulation, selection tracking.

**Transport priority:** WebSocket (via plugin) is preferred. If no plugin is connected, falls back to CDP (requires launching Figma with `--remote-debugging-port=9222`). Most users should just use the plugin.

## Tools

### Session & observation
| Tool | Description |
|-|-|
| `figma_connection` | Navigate to file URL, check status, reconnect, list open files, track changes |
| `figma_get_selection` | Currently selected nodes — IDs, names, types, dimensions. Falls back to direct plugin read if WebSocket cache is empty |
| `figma_get_viewport` | Visible canvas area + nodes in view. Understands what the user is looking at without selection |
| `figma_screenshot` | Capture live plugin screenshot or REST API render |
| `figma_console` | Read, stream, or clear Figma console output |

### Read
| Tool | Description |
|-|-|
| `figma_get_file_data` | Document tree. Start `verbosity='summary' depth=1`, drill with `nodeIds` |
| `figma_get_variables` | Design tokens/variables. Works on all plans via plugin bridge |
| `figma_get_styles` | Color, text, effect, grid styles with optional code exports |
| `figma_get_component` | Single component (metadata, reconstruction spec, or dev format) |
| `figma_find_components` | Search/browse components. Levels: overview > keys > summary > details |
| `figma_get_library_components` | Search team's published library (needs `FIGMA_DESIGN_SYSTEMS`) |

### Write: nodes
| Tool | Description |
|-|-|
| `figma_edit_node` | Resize, move, clone, delete, rename, reparent, reorder |
| `figma_create_nodes` | Create a single node or entire nested tree in one call |
| `figma_manage_page` | Create, delete, rename, switch, reorder, list pages |

### Write: visual properties
| Tool | Description |
|-|-|
| `figma_set_appearance` | Fills, strokes, opacity, corners, effects, rotation, blend mode + variable bindings |
| `figma_set_text` | Content, typography, alignment, decoration + variable bindings for fontSize, lineHeight, etc. |
| `figma_set_layout` | Auto-layout (flexbox) or CSS grid. Padding, gap, alignment, wrap + variable bindings |

### Write: components
| Tool | Description |
|-|-|
| `figma_instantiate_component` | Create instance from component key + node ID |
| `figma_set_instance_properties` | Update text/boolean/variant props on instances |
| `figma_component_property` | Add, edit, delete, describe component properties |
| `figma_combine_as_variants` | Combine COMPONENT nodes into a COMPONENT_SET (variant group) |
| `figma_arrange_component_set` | Organize variant grid with labels and native purple dashed border |

### Write: variables & styles
| Tool | Description |
|-|-|
| `figma_variable_operation` | Single mutation: create, update, delete, rename, add mode, etc. |
| `figma_batch_variables` | Bulk ops on variables, 10-50x faster than single mutations |
| `figma_create_style` | Create, update, delete, list paint/text/effect styles |
| `figma_set_reaction` | Prototyping triggers, actions, transitions |

### Utility
| Tool | Description |
|-|-|
| `figma_batch` | Run up to 25 tools in one request (don't include screenshot — payload too large) |

## Known limitations

**This is early software.** The following are known issues, not aspirational TODOs:

### Stability
- The WebSocket connection between plugin and server can drop silently. If tools start failing, re-run the plugin in Figma.
- Long-running operations (large tree creation, batch variables) can hit the default 5-second timeout. Some tools accept explicit timeout params; others don't.
- After reloading the plugin, cached selection is empty until you change your selection (there's a fallback, but it's slower).

### Missing capabilities
- **Node types:** `figma_create_nodes` supports RECTANGLE, ELLIPSE, FRAME, COMPONENT, TEXT, LINE. No support for POLYGON, STAR, VECTOR, BOOLEAN_OPERATION, or SECTION.
- **Vector editing:** No pen tool, no path manipulation, no boolean operations (union/subtract/intersect).
- **Image fills:** Can't import raster images as fills.
- **Mixed text styles:** `figma_set_text` applies styles uniformly — no per-character formatting within a single text node.
- **Constraints:** Auto-layout min/max sizing with fixed bounds can be tricky.
- **Direct instance edits:** Setting fills, text, or other properties directly on INSTANCE nodes silently fails. Must use `figma_set_instance_properties`.

### Tool quality for LLM consumers
- Some tool descriptions are incomplete or assume Figma data model knowledge.
- Error messages from the QuickJS sandbox can be cryptic.
- Parameter validation happens at multiple layers (Zod, connector, bridge, plugin) with inconsistent error formatting.
- Tool discovery depends on the MCP client — some clients surface tool descriptions poorly.

### Figma plugin sandbox
- The plugin runs in QuickJS, not V8. Some modern JavaScript doesn't work in eval'd code strings.
- `COMPONENT_SET` nodes can't be created directly — create individual `COMPONENT` nodes then use `figma_combine_as_variants`.
- The plugin must be manually re-run after Figma restarts or file switches.

## MCP Apps (experimental)

Interactive UIs that render inside MCP clients supporting [ext-apps](https://github.com/anthropics/anthropic-cookbook/tree/main/misc/model_context_protocol/ext-apps). Enable with `ENABLE_MCP_APPS=true`.

- **Token Browser** — Browse all design tokens by collection, filter by type, search by name
- **Design System Dashboard** — Lighthouse-style health scorecard across naming, tokens, components, accessibility

## Development

```bash
npm run dev:local    # TypeScript watch mode
npm run build        # Full build (TypeScript + apps)
npm run type-check   # Type check without emitting
```

After changing plugin files (`code.js`, `ui.html`): re-run the plugin in Figma. Only re-import `manifest.json` if you changed the manifest itself.

### Project structure

```
src/
  local.ts                         Entry point, server setup, tool instructions
  core/
    figma-desktop-connector.ts     CDP (Puppeteer) transport
    websocket-connector.ts         WebSocket transport
    websocket-server.ts            WebSocket server for plugin communication
    figma-api.ts                   Figma REST API wrapper
    figma-tools.ts                 API-based tools (screenshot, file data, etc.)
    batch-tool.ts                  Multi-tool batch execution
    schema-coerce.ts               MCP string param coercion
  local-tools/
    node-tools.ts                  Node manipulation (edit, appearance, text, layout)
    component-tools.ts             Component operations (find, instantiate, variants)
    variable-tools.ts              Variable/token operations
    connection-tools.ts            Connection, console, selection, viewport
figma-desktop-bridge/
  manifest.json                    Figma plugin manifest
  code.js                          Plugin worker (QuickJS sandbox)
  ui.html                          Plugin UI (WebSocket client, message routing)
```

## License

MIT — See [LICENSE](LICENSE).
