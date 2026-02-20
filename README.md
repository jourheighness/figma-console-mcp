# Figma Console MCP Server

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![npm](https://img.shields.io/npm/v/figma-console-mcp)](https://www.npmjs.com/package/figma-console-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Documentation](https://img.shields.io/badge/docs-docs.figma--console--mcp.southleft.com-0D9488)](https://docs.figma-console-mcp.southleft.com)

> **Your design system as an API.** Model Context Protocol server that bridges design and development — giving AI assistants complete access to Figma for **extraction**, **creation**, and **debugging**.

## What is this?

Figma Console MCP connects AI assistants (like Claude) to your local Figma Desktop, enabling:

- **Design creation** — Create UI components, frames, layouts, and full pages directly in Figma
- **Design system extraction** — Pull variables, components, styles, and file structure
- **Variable management** — Full CRUD on design tokens, collections, and modes
- **Component operations** — Find, instantiate, and manage components and variants
- **Visual debugging** — Take screenshots, capture console logs, monitor errors
- **Design-code parity** — Compare Figma specs against code implementations
- **Real-time monitoring** — Watch console output and track selection changes

---

## Quick Start

### Choose Your Setup

| I want to... | Setup Method |
|-|-|
| **Use it with AI assistants** | [NPX Setup](#npx-setup-recommended) (Recommended) |
| **Contribute to the project** | [Local Git Setup](#for-contributors-local-git-mode) |

---

### NPX Setup (Recommended)

#### Prerequisites

- **Node.js 18+** — Check with `node --version` ([Download](https://nodejs.org))
- **Figma Desktop** installed (not the web app)
- **An MCP client** — Claude Code, Cursor, Windsurf, Claude Desktop, etc.

#### Step 1: Get Your Figma Token

1. Go to [figma.com/developers/api#access-tokens](https://www.figma.com/developers/api#access-tokens)
2. Click **"Get personal access token"**
3. Enter description: `Figma Console MCP`
4. **Copy the token** (starts with `figd_`)

#### Step 2: Configure Your MCP Client

**Claude Code (CLI):**
```bash
claude mcp add figma-console -s user -e FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE -e ENABLE_MCP_APPS=true -- npx -y figma-console-mcp@latest
```

**Cursor / Windsurf / Claude Desktop:**

Add to your MCP config file (see [config file locations](#config-file-locations) below):

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE",
        "ENABLE_MCP_APPS": "true"
      }
    }
  }
}
```

#### Config File Locations

| App | macOS | Windows |
|-|-|-|
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Claude Code (CLI)** | `~/.claude.json` | `%USERPROFILE%\.claude.json` |
| **Cursor** | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |

> **Tip:** `~` means your home folder — `/Users/YourName/` on macOS, `C:\Users\YourName\` on Windows. If the config file doesn't exist yet, create it.
>
> **Claude Code users:** The `claude mcp add` command above handles everything — no manual file editing needed.

#### Step 3: Connect to Figma Desktop

**Option A — Desktop Bridge Plugin (Recommended):**
1. Open Figma Desktop (no special flags needed)
2. Go to **Plugins → Development → Import plugin from manifest...**
3. Select `figma-desktop-bridge/manifest.json` from the figma-console-mcp directory
4. Run the plugin in your Figma file — it auto-connects via WebSocket

> One-time setup. The plugin stays in your Development plugins list.

**Option B — CDP Debug Mode (Alternative):**

Quit Figma completely, then restart with:
- **macOS:** `open -a "Figma" --args --remote-debugging-port=9222`
- **Windows:** `cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222`

Verify at [http://localhost:9222](http://localhost:9222) — you should see inspectable Figma pages.

#### Step 4: Test It

Restart your MCP client, then try:

```
Check Figma status
```
→ Should show connection status with active transport (WebSocket or CDP)

```
Create a simple frame with a blue background
```
→ Should create a frame in Figma (confirms write access)

---

### For Contributors: Local Git Mode

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
npm run build:local
```

Add to your MCP config file:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE",
        "ENABLE_MCP_APPS": "true"
      }
    }
  }
}
```

Then follow [Steps 3-4](#step-3-connect-to-figma-desktop) above.

---

## Available Tools (28)

### Connection & Status
| Tool | Description |
|-|-|
| `figma_connection` | Check status, manage transport, track document changes |
| `figma_console` | Retrieve console logs, watch real-time, clear buffer |
| `figma_get_selection` | Get current selection in Figma |

### File & Data Extraction
| Tool | Description |
|-|-|
| `figma_get_file_data` | Full file structure and node data |
| `figma_get_variables` | Extract design tokens and variables |
| `figma_get_component` | Component data (metadata or reconstruction spec) |
| `figma_get_styles` | Color, text, and effect styles |
| `figma_get_library_components` | Browse team library components |
| `figma_screenshot` | Capture screenshots of nodes or canvas |

### Design Creation
| Tool | Description |
|-|-|
| `figma_edit_node` | Resize, move, clone, delete, rename, reparent, reorder nodes |
| `figma_create_child` | Create new child nodes (frames, text, shapes) |
| `figma_set_appearance` | Set fills, strokes, opacity, corners, effects, blend modes |
| `figma_set_text` | Set text content and typography properties |
| `figma_set_layout` | Configure auto-layout on frames |
| `figma_set_reaction` | Add prototype interactions and transitions |
| `figma_manage_page` | Create, delete, rename, switch, reorder pages |
| `figma_create_style` | Create color, text, and effect styles |

### Components
| Tool | Description |
|-|-|
| `figma_find_components` | Search for components by name or key |
| `figma_instantiate_component` | Create instances of components |
| `figma_set_instance_properties` | Set properties on component instances |
| `figma_component_property` | Manage component properties and descriptions |
| `figma_arrange_component_set` | Organize variants into component sets |

### Variables & Tokens
| Tool | Description |
|-|-|
| `figma_variable_operation` | Create, update, rename, delete variables and collections |
| `figma_batch_variables` | Batch create/update variables (up to 100 per call) |

### Design-Code Parity
| Tool | Description |
|-|-|
| `figma_check_design_parity` | Compare Figma component specs against code |
| `figma_generate_component_doc` | Generate component documentation from Figma + code |

### Utilities
| Tool | Description |
|-|-|
| `figma_comments` | Read and post comments on Figma files |
| `figma_batch` | Execute multiple API operations in one call |

---

## MCP Apps (Experimental)

Interactive UI experiences that render directly inside MCP clients supporting the [ext-apps protocol](https://github.com/anthropics/anthropic-cookbook/tree/main/misc/model_context_protocol/ext-apps). Enabled via `ENABLE_MCP_APPS=true`.

### Token Browser

Ask: *"Browse the design tokens"*

- Browse all tokens organized by collection
- Filter by type (Colors, Numbers, Strings) and search by name
- Per-collection mode columns matching Figma's Variables panel
- Color swatches, alias resolution, click-to-copy

### Design System Dashboard

Ask: *"Audit the design system"*

- Lighthouse-style health scorecard (0–100) across six categories
- Naming, Tokens, Components, Accessibility, Consistency, Coverage
- Expandable findings with severity indicators and actionable details
- Refresh without consuming AI context

---

## Desktop Bridge Plugin

The recommended connection method. Communicates via WebSocket — no special Figma launch flags needed.

### Setup

1. Open Figma Desktop
2. **Plugins → Development → Import plugin from manifest...**
3. Select `figma-desktop-bridge/manifest.json`
4. Run the plugin — it auto-connects (scans ports 9223–9232)

### Transport

- **WebSocket first** (port 9223) via the Desktop Bridge plugin
- **CDP fallback** (port 9222) if Figma was launched with `--remote-debugging-port=9222`
- Transport is selected automatically per-command
- All 28 tools work through either transport

### Multi-Instance Support

Multiple MCP server instances can run simultaneously (e.g., Claude Desktop tabs, multiple CLI terminals). The server automatically falls back through ports 9223–9232, and the plugin connects to all active servers.

### Environment Variables

| Variable | Default | Description |
|-|-|-|
| `FIGMA_ACCESS_TOKEN` | — | Figma personal access token (required) |
| `FIGMA_TEAM_ID` | — | Team ID for library component discovery |
| `FIGMA_WS_PORT` | `9223` | Preferred WebSocket port (falls back through 10-port range) |
| `FIGMA_WS_HOST` | `localhost` | WebSocket bind address (`0.0.0.0` for Docker) |
| `ENABLE_MCP_APPS` | `false` | Enable interactive MCP Apps |

---

## vs. Figma Official MCP

**Figma Console MCP (This Project)** — Full design system access
- Real-time console logs and error monitoring
- Screenshot capture and visual debugging
- Design creation and variable management
- Raw design data extraction
- Runs locally with Desktop Bridge

**Figma Official Dev Mode MCP** — Code generation
- Generates React/HTML from designs
- Tailwind/CSS class generation
- Component boilerplate scaffolding

**Use both together** for the complete workflow: generate code with Official MCP, debug and build designs with Console MCP.

---

## Development

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
npm run dev:local    # Development mode
npm run build:local  # Build
```

---

## Links

- [Documentation Site](https://docs.figma-console-mcp.southleft.com) — Complete guides and API reference
- [Local Docs](docs/) — Documentation source files
- [Report Issues](https://github.com/southleft/figma-console-mcp/issues)
- [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Figma API](https://www.figma.com/developers/api)

## License

MIT — See [LICENSE](LICENSE) file.
