---
title: "Setup Guide"
description: "Complete setup instructions for connecting Figma Console MCP to Claude Desktop, GitHub Copilot, Cursor, Windsurf, and other AI clients."
---

# Figma Console MCP - Setup Guide

Complete setup instructions for connecting Figma Console MCP to various AI clients including Claude Desktop, GitHub Copilot (VS Code), Cursor, Windsurf, and more.

---

## 🎯 Choose Your Setup

**First, decide what you want to do:**

| I want to... | Setup Method | Time |
|--------------|--------------|------|
| **Create, modify, and develop with AI** | [NPX Setup](#-npx-setup-recommended) (Recommended) | ~10 min |
| **Full capabilities with manual update control** | [Local Git Setup](#-local-git-setup-alternative) | ~15 min |

---

## 🚀 NPX Setup (Recommended)

**Best for:** Anyone who wants full AI-assisted design and development capabilities with automatic updates.

**What you get:** All 56+ tools including design creation, variable management, component instantiation, design-to-code workflows, and Desktop Bridge plugin support.

### Prerequisites Checklist

Before starting, verify you have:

- [ ] **Node.js 18+** installed — Check with `node --version` ([Download](https://nodejs.org))
- [ ] **Figma Desktop** installed (not just the web app)
- [ ] **An MCP client** installed (Claude Desktop, Claude Code, Cursor, Windsurf, etc.)

### Step 1: Get Your Figma Token (~2 min)

1. Go to [figma.com/developers/api#access-tokens](https://www.figma.com/developers/api#access-tokens)
2. Click **"Get personal access token"**
3. Enter description: `Figma Console MCP`
4. Click **"Generate token"**
5. **Copy the token immediately** — you won't see it again!

> 💡 Your token starts with `figd_` — if it doesn't, something went wrong.

### Step 2: Configure Your MCP Client (~3 min)

#### Claude Code (CLI)

```bash
claude mcp add figma-console -s user -e FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE -e ENABLE_MCP_APPS=true -- npx -y figma-console-mcp@latest
```

#### Cursor / Windsurf / Other MCP Clients

Find your client's MCP config file and add:

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

#### Claude Desktop

1. Open Claude Desktop
2. Go to **Settings** → **Developer** → **Edit Config** (or manually edit the config file)
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

3. Add the same JSON configuration shown above

4. **Save the file**

### Step 3: Connect to Figma Desktop (~2 min)

Choose one of two connection methods:

#### Option A: Desktop Bridge Plugin (Recommended)

The Desktop Bridge Plugin connects via WebSocket — no special Figma launch flags needed, and it persists across Figma restarts.

1. **Open Figma Desktop** (normal launch, no special flags)
2. Go to **Plugins** → **Development** → **Import plugin from manifest...**
3. Navigate to the `figma-desktop-bridge/manifest.json` file in the figma-console-mcp directory
   - **NPX users:** Run `npx figma-console-mcp@latest --print-path` to find the directory
4. Click **"Open"** — the plugin appears in your Development plugins list
5. **Run the plugin** in your Figma file (Plugins → Development → Figma Desktop Bridge)
6. The plugin auto-connects via WebSocket (scans ports 9223–9232) — you'll see a "Connected" indicator

> **One-time setup.** Once imported, the plugin stays in your Development plugins list. Just run it whenever you want to use the MCP. No need to restart Figma with special flags.

**📖 [Desktop Bridge Plugin Documentation](https://github.com/southleft/figma-console-mcp/tree/main/figma-desktop-bridge)**

#### Option B: CDP Debug Mode (Alternative)

If the Desktop Bridge Plugin isn't connecting, or you need full-page console monitoring (captures all page-level logs, not just plugin context), you can use Chrome DevTools Protocol instead.

1. **Quit Figma completely** (Cmd+Q on macOS, Alt+F4 on Windows)

2. **Restart Figma with the debug flag:**

   **macOS (Terminal):**
   ```bash
   open -a "Figma" --args --remote-debugging-port=9222
   ```

   **Windows (CMD or PowerShell):**
   ```
   cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222
   ```

3. **Verify it worked:** Open Chrome and visit [http://localhost:9222](http://localhost:9222)
   - ✅ You should see a list of inspectable Figma pages
   - ❌ If blank or error, Figma wasn't started correctly — try again

> ⚠️ **You must restart Figma with this flag every time** you quit Figma. Consider creating a desktop shortcut or alias. You can also use **both** methods simultaneously — the MCP server tries WebSocket first and falls back to CDP automatically.

### Step 4: Restart Your MCP Client (~1 min)

1. **Restart your MCP client** (quit and reopen Claude Code, Cursor, Windsurf, Claude Desktop, etc.)
2. Verify the MCP server is connected (e.g., in Claude Desktop look for the 🔌 icon showing "figma-console: connected")

### Step 5: Test It! (~2 min)

Try these prompts to verify everything works:

```
Check Figma status
```
→ Should show connection status including which transport is active (WebSocket or CDP)

```
Search for button components
```
→ Should return component results from your open Figma file

```
Create a simple frame with a blue background
```
→ Should create a frame in your Figma file (this confirms write access!)

**🎉 You're all set!** You now have full AI-assisted design capabilities.

---

## 🔧 Local Git Setup (Alternative)

**Best for:** Users who want more control over when updates happen, or developers who want to contribute to the project.

**What you get:** Same 56+ tools as NPX. Updates are manual — you pull and rebuild when you're ready.

### Prerequisites

- [ ] Node.js 18+ installed
- [ ] Git installed
- [ ] Figma Desktop installed
- [ ] An MCP client installed (Claude Desktop, Claude Code, Cursor, Windsurf, etc.)

### Step 1: Clone and Build

```bash
# Clone the repository
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp

# Install dependencies
npm install

# Build for local mode
npm run build:local
```

### Step 2: Get Figma Token

Same as [NPX Step 1](#step-1-get-your-figma-token-2-min) above.

### Step 3: Configure Your MCP Client

#### Claude Code (CLI)

```bash
claude mcp add figma-console -s user -e FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE -- node /absolute/path/to/figma-console-mcp/dist/local.js
```

#### Other MCP Clients (Cursor, Windsurf, Claude Desktop, etc.)

Edit your client's MCP config file:

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

**Important:**
- Replace `/absolute/path/to/figma-console-mcp` with the actual path where you cloned the repo
- Use forward slashes `/` even on Windows

### Step 4: Connect to Figma Desktop

Same as [NPX Step 3](#step-3-connect-to-figma-desktop-2-min) above — install the Desktop Bridge Plugin (recommended) or use CDP debug mode (alternative).

### Step 5: Restart Your MCP Client and Test

Same as [NPX Steps 4 & 5](#step-4-restart-your-mcp-client-1-min) above.

### Updating

To get the latest changes:

```bash
cd figma-console-mcp
git pull
npm install
npm run build:local
```

Then restart Claude Desktop.

---

## 🤖 GitHub Copilot (VS Code)

GitHub Copilot supports MCP servers as of VS Code 1.102+.

### Prerequisites

- VS Code 1.102 or later
- GitHub Copilot extension installed and active
- For full capabilities: Node.js 18+ and Figma Personal Access Token

### Quick Setup (CLI)

**Full capabilities (recommended):**
```bash
# Create env file for your token
echo "FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE" > ~/.figma-console-mcp.env

# Add the server
code --add-mcp '{"name":"figma-console","command":"npx","args":["-y","figma-console-mcp@latest"],"envFile":"~/.figma-console-mcp.env"}'
```

### Manual Configuration

Create `.vscode/mcp.json` in your project:

**Full capabilities:**
```json
{
  "servers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

> **Security Tip:** Use `envFile` instead of inline `env` to keep tokens out of version control.

### Starting the Server

1. Open Command Palette (**Cmd+Shift+P** / **Ctrl+Shift+P**)
2. Run **"MCP: List Servers"**
3. Click on **"figma-console"** to start it
4. VS Code may prompt you to **trust the server** — click Allow

---

## 🛠️ Troubleshooting

### Quick Fixes

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| "Failed to connect to Figma Desktop" | No transport available | Install Desktop Bridge Plugin, or restart Figma with `--remote-debugging-port=9222` |
| "FIGMA_ACCESS_TOKEN not configured" | Missing or wrong token | Check token in config, must start with `figd_` |
| "Command not found: node" | Node.js not installed | Install Node.js 18+ from nodejs.org |
| Tools not appearing in MCP client | Config not loaded | Restart your MCP client completely |
| "Port 9222 already in use" | Another process using port | Close Chrome windows, check Task Manager |
| "Port 9223 already in use" | Another MCP instance running | As of v1.10.0, the server automatically falls back to ports 9224–9232. If the plugin can't connect, re-import the Desktop Bridge manifest. |
| WebSocket unreachable from Docker host | Server bound to localhost | Set `FIGMA_WS_HOST=0.0.0.0` and expose port with `-p 9223:9223` |
| Plugin shows "Disconnected" | MCP server not running | Start/restart your MCP client so the server starts |
| NPX using old version | Cached package | Use `figma-console-mcp@latest` explicitly |

### Node.js Version Issues

**Symptom:** Cryptic errors like "parseArgs not exported from 'node:util'"

**Fix:** You need Node.js 18 or higher.

```bash
# Check your version
node --version

# Should show v18.x.x or higher
```

If using **NVM** and having issues, try using the absolute path to Node:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "/Users/yourname/.nvm/versions/node/v20.10.0/bin/node",
      "args": ["-e", "require('figma-console-mcp')"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

### Figma Debug Mode Not Working

1. **Completely quit Figma** — not just close the window
   - macOS: Cmd+Q or Figma menu → Quit Figma
   - Windows: Alt+F4 or right-click taskbar icon → Close window

2. **Verify Figma is fully closed:**
   - macOS: `ps aux | grep -i figma` should show nothing
   - Windows: Check Task Manager for Figma processes

3. **Restart with the flag:**
   - macOS: `open -a "Figma" --args --remote-debugging-port=9222`
   - Windows: `cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222`

4. **Verify:** Visit http://localhost:9222 — should show inspectable pages

### Config File Syntax Errors

If Claude Desktop doesn't see your MCP server:

1. **Validate your JSON:** Use a tool like [jsonlint.com](https://jsonlint.com)
2. **Check for common mistakes:**
   - Missing commas between properties
   - Trailing commas (not allowed in JSON)
   - Wrong quote characters (must be `"` not `'` or smart quotes)
3. **Copy the exact config** from this guide — don't retype it

### Still Having Issues?

1. Check the [GitHub Issues](https://github.com/southleft/figma-console-mcp/issues)
2. Ask in [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
3. Include:
   - Your setup method (NPX or Local Git)
   - The exact error message
   - Output of `node --version`
   - Your MCP client (Claude Desktop, Claude Code, etc.)

---

## Optional: Enable MCP Apps

MCP Apps provide interactive UI experiences like the Token Browser and Design System Dashboard. As of v1.10.0, `ENABLE_MCP_APPS=true` is included in the default configuration examples above.

If you set up before v1.10.0, add `"ENABLE_MCP_APPS": "true"` to the `env` section of your MCP config.

> **Note:** MCP Apps require a client with [ext-apps protocol](https://github.com/anthropics/anthropic-cookbook/tree/main/misc/model_context_protocol/ext-apps) support.

---

## Next Steps

1. **Try example prompts:** See [Use Cases](use-cases) for workflow examples
2. **Explore all tools:** See [Tools Reference](tools) for the complete tool list
3. **Learn about the Desktop Bridge plugin:** See [Desktop Bridge README](https://github.com/southleft/figma-console-mcp/tree/main/figma-desktop-bridge) for advanced configuration

---

## Support

- 📖 [Full Documentation](/)
- 🐛 [Report Issues](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
