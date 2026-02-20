---
title: "Tools Reference"
description: "Complete API reference for all 56+ MCP tools in Local Mode, including parameters, return values, and usage examples."
---

# Available Tools - Detailed Documentation

This guide provides detailed documentation for each tool, including when to use them and best practices.

> **Note:** Figma Console MCP provides **56+ tools** with full read/write capabilities. Tools marked "Local" in the table below require the Desktop Bridge plugin running in Figma.

## Quick Reference

| Category | Tool | Purpose | Mode |
|----------|------|---------|------|
| **🧭 Navigation** | `figma_navigate` | Open a Figma URL and start monitoring | All |
| | `figma_get_status` | Check browser and monitoring status | All |
| | `figma_reconnect` | Reconnect to Figma Desktop | Local |
| **📋 Console** | `figma_get_console_logs` | Retrieve console logs with filters | All |
| | `figma_watch_console` | Stream logs in real-time | All |
| | `figma_clear_console` | Clear log buffer | All |
| **🔍 Debugging** | `figma_take_screenshot` | Capture UI screenshots | All |
| | `figma_reload_plugin` | Reload current page | All |
| **🎨 Design System** | `figma_get_variables` | Extract design tokens/variables | All |
| | `figma_get_styles` | Get color, text, effect styles | All |
| | `figma_get_component` | Get component data | All |
| | `figma_get_component_for_development` | Component + visual reference | All |
| | `figma_get_component_image` | Just the component image | All |
| | `figma_get_file_data` | File structure with verbosity control | All |
| | `figma_get_file_for_plugin` | File data optimized for plugins | All |
| **✏️ Design Creation** | `figma_arrange_component_set` | Organize variants with labels | Local |
| **🧩 Components** | `figma_find_components` | Find components by name, details, keys, or design system overview | Local |
| | `figma_instantiate_component` | Create component instance | Local |
| | `figma_add_component_property` | Add component property | Local |
| | `figma_edit_component_property` | Edit component property | Local |
| | `figma_delete_component_property` | Remove component property | Local |
| | `figma_component_property` | Set description on components (action: "set_description") | Local |
| **🔧 Variables** | `figma_create_variable_collection` | Create collections with modes | Local |
| | `figma_create_variable` | Create new variables | Local |
| | `figma_update_variable` | Update variable values | Local |
| | `figma_rename_variable` | Rename variables | Local |
| | `figma_delete_variable` | Delete variables | Local |
| | `figma_delete_variable_collection` | Delete collections | Local |
| | `figma_add_mode` | Add modes to collections | Local |
| | `figma_rename_mode` | Rename modes | Local |
| | `figma_batch_variables` | Batch create, update, or setup complete token systems (action: "create", "update", "setup") | Local |
| **🔍 Design-Code Parity** | `figma_check_design_parity` | Compare Figma specs vs code implementation | All |
| | `figma_generate_component_doc` | Generate component documentation from Figma + code | All |
| **💬 Comments** | `figma_comments` | Get, post, or delete comments (action: "get", "post", "delete") | All |
| **📐 Node Manipulation** | `figma_edit_node` | Resize, move, clone, delete, rename, reparent, reorder nodes | Local |
| | `figma_set_text` | Set text content | Local |
| | `figma_set_appearance` | Set fills, strokes, opacity, cornerRadius, effects, rotation, blendMode | Local |
| | `figma_create_child` | Create child node | Local |

---

## 🧭 Navigation & Status Tools

### `figma_navigate`

Navigate to any Figma URL to start monitoring.

**Usage:**
```javascript
figma_navigate({
  url: 'https://www.figma.com/design/abc123/My-Design?node-id=1-2'
})
```

**Always use this first** to initialize the browser and start console monitoring.

**Returns:**
- Navigation status
- Current URL
- Console monitoring status

---

### `figma_get_status`

Check connection and monitoring status. **In local mode, validates transport connectivity (WebSocket and/or CDP) and shows which transport is active.**

**Usage:**
```javascript
figma_get_status()
```

**Returns:**
- **Setup validation** (local mode only):
  - `setup.valid` - Whether a transport (WebSocket or CDP) is available
  - `setup.message` - Human-readable status including active transport
  - `setup.transport` - Which transport is active (`websocket`, `cdp`, or `none`)
  - `setup.setupInstructions` - Step-by-step setup guide (if no transport available)
  - `setup.ai_instruction` - Guidance for AI assistants
- Browser connection status
- Console monitoring active/inactive
- Current URL (if navigated)
- Number of captured console logs

**Example Response (Local Mode - WebSocket Connected):**
```json
{
  "mode": "local",
  "setup": {
    "valid": true,
    "message": "✅ Figma Desktop connected via WebSocket (Desktop Bridge Plugin)"
  }
}
```

**Example Response (Local Mode - CDP Connected):**
```json
{
  "mode": "local",
  "setup": {
    "valid": true,
    "message": "✅ Figma Desktop connected via CDP (debug port 9222)"
  }
}
```

**Example Response (Local Mode - No Transport):**
```json
{
  "mode": "local",
  "setup": {
    "valid": false,
    "message": "❌ No connection to Figma Desktop",
    "setupInstructions": {
      "recommended": "Install Desktop Bridge Plugin: Figma → Plugins → Development → Import from manifest",
      "alternative_macOS": "open -a \"Figma\" --args --remote-debugging-port=9222",
      "alternative_windows": "cmd /c \"%LOCALAPPDATA%\\Figma\\Figma.exe\" --remote-debugging-port=9222"
    }
  }
}
```

**Best Practice:**
- Call this tool first when starting a session in local mode
- If `setup.valid` is false, guide user to install the Desktop Bridge Plugin (recommended) or restart Figma with debug flag (alternative)

---

## 📋 Console Tools (Plugin Debugging)

### `figma_get_console_logs`

> **💡 Plugin Developers in Local Mode**: This tool works immediately - no navigation required!
> Just check logs, run your plugin in Figma Desktop, check logs again. All `[Main]`, `[Swapper]`, etc. plugin logs appear instantly.

Retrieve console logs with filters.

**Usage:**
```javascript
figma_get_console_logs({
  count: 50,           // Number of logs to retrieve (default: 100)
  level: 'error',      // Filter by level: 'log', 'info', 'warn', 'error', 'debug', 'all'
  since: 1234567890    // Unix timestamp (ms) - only logs after this time
})
```

**Parameters:**
- `count` (optional): Number of recent logs to retrieve (default: 100)
- `level` (optional): Filter by log level (default: 'all')
- `since` (optional): Unix timestamp in milliseconds - only logs after this time

**Returns:**
- Array of console log entries with:
  - `timestamp`: Unix timestamp (ms)
  - `level`: 'log', 'info', 'warn', 'error', 'debug'
  - `message`: The log message
  - `args`: Additional arguments passed to console method
  - `stackTrace`: Stack trace (for errors)

**Example:**
```javascript
// Get last 20 error logs
figma_get_console_logs({ count: 20, level: 'error' })

// Get all logs from last 30 seconds
const thirtySecondsAgo = Date.now() - (30 * 1000);
figma_get_console_logs({ since: thirtySecondsAgo })
```

---

### `figma_watch_console`

Stream console logs in real-time for a specified duration.

**Usage:**
```javascript
figma_watch_console({
  duration: 30,        // Watch for 30 seconds (default: 30, max: 300)
  level: 'all'         // Filter by level (default: 'all')
})
```

**Parameters:**
- `duration` (optional): How long to watch in seconds (default: 30, max: 300)
- `level` (optional): Filter by log level (default: 'all')

**Returns:**
- Real-time stream of console logs captured during the watch period
- Summary of total logs captured by level

**Use case:** Perfect for monitoring console output while you test your plugin manually.

---

### `figma_clear_console`

Clear the console log buffer.

**Usage:**
```javascript
figma_clear_console()
```

**Returns:**
- Confirmation of buffer cleared
- Number of logs that were cleared

---

## 🔍 Debugging Tools

### `figma_take_screenshot`

Capture screenshots of Figma UI.

**Usage:**
```javascript
figma_take_screenshot({
  target: 'plugin',           // 'plugin', 'full-page', or 'viewport'
  format: 'png',              // 'png' or 'jpeg'
  quality: 90,                // JPEG quality 0-100 (default: 90)
  filename: 'my-screenshot'   // Optional filename
})
```

**Parameters:**
- `target` (optional): What to screenshot
  - `'plugin'`: Just the plugin UI (default)
  - `'full-page'`: Entire scrollable page
  - `'viewport'`: Current visible viewport
- `format` (optional): Image format (default: 'png')
- `quality` (optional): JPEG quality 0-100 (default: 90)
- `filename` (optional): Custom filename

**Returns:**
- Screenshot image
- Metadata (dimensions, format, size)

---

### `figma_reload_plugin`

Reload the current Figma page.

**Usage:**
```javascript
figma_reload_plugin({
  clearConsole: true   // Clear console logs before reload (default: true)
})
```

**Returns:**
- Reload status
- New page URL (if changed)

---

## 🎨 Design System Tools

> **⚠️ All Design System tools require `FIGMA_ACCESS_TOKEN`** configured in your MCP client.
>
> See [Installation Guide](../README.md#step-2-add-your-figma-access-token-for-design-system-tools) for setup instructions.

### `figma_get_variables`

Extract design tokens/variables from a Figma file. Supports both main files and branches.

**Usage:**
```javascript
figma_get_variables({
  fileUrl: 'https://figma.com/design/abc123',
  includePublished: true,                        // Include published library variables
  enrich: true,                                  // Add CSS/Tailwind exports
  export_formats: ['css', 'tailwind', 'sass'],   // Export formats
  include_usage: true,                           // Show where variables are used
  include_dependencies: true                     // Show variable dependencies
})
```

**Branch Support:**

The tool automatically detects and handles Figma branch URLs in both formats:

```javascript
// Path-based branch URL
figma_get_variables({
  fileUrl: 'https://figma.com/design/abc123/branch/xyz789/My-File'
})

// Query-based branch URL
figma_get_variables({
  fileUrl: 'https://figma.com/design/abc123/My-File?branch-id=xyz789'
})
```

**Auto-Detection:** If you've navigated to a file using `figma_navigate`, you can omit `fileUrl` entirely:

```javascript
// First navigate to the branch
figma_navigate({ url: 'https://figma.com/design/abc123/branch/xyz789/My-File' })

// Then get variables from the current file
figma_get_variables({ refreshCache: true })
```

**Parameters:**
- `fileUrl` (optional): Figma file URL - supports main files and branches (uses current if navigated)
- `includePublished` (optional): Include published variables (default: true)
- `enrich` (optional): Add exports and usage analysis (default: false)
- `export_formats` (optional): Code formats to generate
- `include_usage` (optional): Include usage in styles/components
- `include_dependencies` (optional): Include dependency graph
- `refreshCache` (optional): Force fresh data fetch, bypassing cache

**Returns:**
- Variable collections
- Variables with modes and values
- Summary statistics
- Export code (if `enrich: true`)
- Usage information (if `include_usage: true`)
- Branch info (when using branch URL): `fileKey`, `branchId`, `isBranch`

**Note:** Figma Variables API requires Enterprise plan. If unavailable, the tool automatically falls back to Styles API or console-based extraction.

---

### `figma_get_styles`

Get all styles (color, text, effects) from a Figma file.

**Usage:**
```javascript
figma_get_styles({
  fileUrl: 'https://figma.com/design/abc123',
  enrich: true,                                  // Add code exports
  export_formats: ['css', 'tailwind'],           // Export formats
  include_usage: true,                           // Show component usage
  include_exports: true                          // Include code examples
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `enrich` (optional): Add exports and usage (default: false)
- `export_formats` (optional): Code formats to generate
- `include_usage` (optional): Show where styles are used
- `include_exports` (optional): Include code examples

**Returns:**
- All styles (color, text, effect, grid)
- Style metadata and properties
- Export code (if `enrich: true`)
- Usage information (if requested)

---

### `figma_get_component`

Get component data in two export formats: metadata (default) or reconstruction specification.

**Usage:**
```javascript
// Metadata format (default) - for documentation and style guides
figma_get_component({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '123:456',
  format: 'metadata',  // or omit for default
  enrich: true         // Add token coverage analysis
})

// Reconstruction format - for programmatic component creation
figma_get_component({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '123:456',
  format: 'reconstruction'  // Compatible with Figma Component Reconstructor plugin
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `nodeId` (required): Component node ID (e.g., '123:456')
- `format` (optional): Export format - `'metadata'` (default) or `'reconstruction'`
- `enrich` (optional): Add quality metrics (default: false, only for metadata format)

**Export Formats:**

**Metadata Format** (default):
- Component metadata and documentation
- Properties and variants
- Bounds and layout info
- Token coverage (if `enrich: true`)
- Use for: Documentation, style guides, design system references

**Reconstruction Format**:
- Complete node tree specification
- All visual properties (fills, strokes, effects)
- Layout properties (auto-layout, padding, spacing)
- Text properties with font information
- Color values in 0-1 normalized RGB format
- Validation of spec against plugin requirements
- Use for: Programmatic component creation, version control, component migration
- Compatible with: Figma Component Reconstructor plugin

---

### `figma_get_component_for_development`

Get component data optimized for UI implementation, with visual reference.

**Usage:**
```javascript
figma_get_component_for_development({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '695:313',
  includeImage: true   // Include rendered image (default: true)
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `nodeId` (required): Component node ID
- `includeImage` (optional): Include rendered image (default: true)

**Returns:**
- Component image (rendered at 2x scale)
- Filtered component data with:
  - Layout properties (auto-layout, padding, spacing)
  - Visual properties (fills, strokes, effects)
  - Typography
  - Component properties and variants
  - Bounds and positioning

**Excludes:** Plugin data, document metadata (optimized for UI implementation)

---

### `figma_get_component_image`

Render a component as an image only.

**Usage:**
```javascript
figma_get_component_image({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '695:313',
  scale: 2,              // Image scale (0.01-4, default: 2)
  format: 'png'          // 'png', 'jpg', 'svg', 'pdf'
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `nodeId` (required): Node ID to render
- `scale` (optional): Scale factor (default: 2)
- `format` (optional): Image format (default: 'png')

**Returns:**
- Image URL (expires after 30 days)
- Image metadata

---

### `figma_get_file_data`

Get file structure with verbosity control.

**Usage:**
```javascript
figma_get_file_data({
  fileUrl: 'https://figma.com/design/abc123',
  depth: 2,                  // Levels of children (0-3, default: 1)
  verbosity: 'standard',     // 'summary', 'standard', 'full'
  nodeIds: ['123:456'],      // Specific nodes only (optional)
  enrich: true               // Add file statistics and health metrics
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `depth` (optional): Depth of children tree (max: 3)
- `verbosity` (optional): Data detail level
  - `'summary'`: IDs, names, types only (~90% smaller)
  - `'standard'`: Essential properties (~50% smaller)
  - `'full'`: Everything
- `nodeIds` (optional): Retrieve specific nodes only
- `enrich` (optional): Add statistics and metrics

**Returns:**
- File metadata
- Document tree (filtered by verbosity)
- Component/style counts
- Statistics (if `enrich: true`)

---

### `figma_get_file_for_plugin`

Get file data optimized for plugin development.

**Usage:**
```javascript
figma_get_file_for_plugin({
  fileUrl: 'https://figma.com/design/abc123',
  depth: 3,                  // Higher depth allowed (max: 5)
  nodeIds: ['123:456']       // Specific nodes (optional)
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `depth` (optional): Depth of children (max: 5, default: 2)
- `nodeIds` (optional): Specific nodes only

**Returns:**
- Filtered file data with:
  - IDs, names, types
  - Plugin data (pluginData, sharedPluginData)
  - Component relationships
  - Lightweight bounds
  - Structure for navigation

**Excludes:** Visual properties (fills, strokes, effects) - optimized for plugin work

---

## Tool Comparison

### When to Use Each Tool

**For Component Development:**
- `figma_get_component_for_development` - Best for implementing UI components (includes image + layout data)
- `figma_get_component_image` - Just need a visual reference
- `figma_get_component` - Need full component metadata

**For Plugin Development:**
- `figma_get_file_for_plugin` - Optimized file structure for plugins
- `figma_get_console_logs` - Debug plugin code
- `figma_watch_console` - Monitor plugin execution

**For Design System Extraction:**
- `figma_get_variables` - Design tokens with code exports
- `figma_get_styles` - Traditional styles with code exports
- `figma_get_file_data` - Full file structure with verbosity control

**For Debugging:**
- `figma_get_console_logs` - Retrieve specific logs
- `figma_watch_console` - Live monitoring
- `figma_take_screenshot` - Visual debugging
- `figma_get_status` - Check connection health

---

---

## ✏️ Design Creation Tools (Local Mode Only)

> **⚠️ Requires Desktop Bridge Plugin**: These tools only work in Local Mode with the Desktop Bridge plugin running in Figma.

## 🔧 Variable Management Tools (Local Mode Only)

> **⚠️ Requires Desktop Bridge Plugin**: These tools only work in Local Mode with the Desktop Bridge plugin running in Figma.

### `figma_create_variable_collection`

Create a new variable collection with optional modes.

**When to Use:**
- Setting up a new design system
- Creating themed variable sets (colors, spacing, typography)
- Organizing variables into logical groups

**Usage:**
```javascript
figma_create_variable_collection({
  name: "Brand Colors",
  initialModeName: "Light",        // Optional: rename default mode
  additionalModes: ["Dark", "High Contrast"]  // Optional: add more modes
})
```

**Parameters:**
- `name` (required): Collection name
- `initialModeName` (optional): Name for the default mode (otherwise "Mode 1")
- `additionalModes` (optional): Array of additional mode names to create

**Returns:**
- Created collection with ID, name, modes, and mode IDs

---

### `figma_create_variable`

Create a new variable in a collection.

**When to Use:**
- Adding design tokens to your system
- Creating colors, spacing values, text strings, or boolean flags
- Setting up multi-mode variable values

**Usage:**
```javascript
figma_create_variable({
  name: "colors/primary/500",
  collectionId: "VariableCollectionId:123:456",
  resolvedType: "COLOR",
  valuesByMode: {
    "1:0": "#3B82F6",    // Light mode
    "1:1": "#60A5FA"     // Dark mode
  },
  description: "Primary brand color",  // Optional
  scopes: ["ALL_FILLS"]                 // Optional
})
```

**Parameters:**
- `name` (required): Variable name (use `/` for grouping)
- `collectionId` (required): Target collection ID
- `resolvedType` (required): `"COLOR"`, `"FLOAT"`, `"STRING"`, or `"BOOLEAN"`
- `valuesByMode` (optional): Object mapping mode IDs to values
- `description` (optional): Variable description
- `scopes` (optional): Where variable can be applied

**Value Formats:**
- **COLOR**: Hex string `"#FF0000"` or `"#FF0000FF"` (with alpha)
- **FLOAT**: Number `16` or `1.5`
- **STRING**: Text `"Hello World"`
- **BOOLEAN**: `true` or `false`

---

### `figma_update_variable`

Update a variable's value in a specific mode.

**When to Use:**
- Changing existing token values
- Updating theme-specific values
- Modifying design system tokens

**Usage:**
```javascript
figma_update_variable({
  variableId: "VariableID:123:456",
  modeId: "1:0",
  value: "#10B981"  // New color value
})
```

**Parameters:**
- `variableId` (required): Variable ID to update
- `modeId` (required): Mode ID to update value in
- `value` (required): New value (format depends on variable type)

---

### `figma_rename_variable`

Rename a variable while preserving all its values.

**When to Use:**
- Reorganizing variable naming conventions
- Fixing typos in variable names
- Moving variables to different groups

**Usage:**
```javascript
figma_rename_variable({
  variableId: "VariableID:123:456",
  newName: "colors/brand/primary"
})
```

**Parameters:**
- `variableId` (required): Variable ID to rename
- `newName` (required): New name (can include `/` for grouping)

---

### `figma_delete_variable`

Delete a variable.

**When to Use:**
- Removing unused tokens
- Cleaning up design system
- Removing deprecated variables

**Usage:**
```javascript
figma_delete_variable({
  variableId: "VariableID:123:456"
})
```

**⚠️ Warning:** This action cannot be undone programmatically. Use Figma's Undo if needed.

---

### `figma_delete_variable_collection`

Delete a collection and ALL its variables.

**When to Use:**
- Removing entire token sets
- Cleaning up unused collections
- Resetting design system sections

**Usage:**
```javascript
figma_delete_variable_collection({
  collectionId: "VariableCollectionId:123:456"
})
```

**⚠️ Warning:** This deletes ALL variables in the collection. Cannot be undone programmatically.

---

### `figma_add_mode`

Add a new mode to an existing collection.

**When to Use:**
- Adding theme variants (Dark mode, High Contrast)
- Adding responsive breakpoints (Mobile, Tablet, Desktop)
- Adding brand variants

**Usage:**
```javascript
figma_add_mode({
  collectionId: "VariableCollectionId:123:456",
  modeName: "Dark"
})
```

**Parameters:**
- `collectionId` (required): Collection to add mode to
- `modeName` (required): Name for the new mode

**Returns:**
- Updated collection with new mode ID

**Note:** Figma has limits on the number of modes per collection (varies by plan).

---

### `figma_rename_mode`

Rename an existing mode in a collection.

**When to Use:**
- Fixing mode names
- Updating naming conventions
- Making mode names more descriptive

**Usage:**
```javascript
figma_rename_mode({
  collectionId: "VariableCollectionId:123:456",
  modeId: "1:0",
  newName: "Light Theme"
})
```

**Parameters:**
- `collectionId` (required): Collection containing the mode
- `modeId` (required): Mode ID to rename
- `newName` (required): New name for the mode

---

### `figma_batch_variables`

Create, update, or set up complete design token systems in a single operation — up to 50x faster than individual calls.

**When to Use:**
- Creating multiple design tokens at once (e.g., a full color palette)
- Updating many token values at once (e.g., theme refresh)
- Importing or syncing variables from an external source
- Any time you need to create or update more than 2-3 variables
- Setting up a new design system from scratch (collection + modes + variables atomically)

**Usage (action: "create"):**
```javascript
figma_batch_variables({
  action: "create",
  collectionId: "VariableCollectionId:123:456",
  variables: [
    {
      name: "colors/primary/500",
      resolvedType: "COLOR",
      description: "Primary brand color",
      valuesByMode: { "1:0": "#3B82F6", "1:1": "#60A5FA" }
    },
    {
      name: "colors/primary/600",
      resolvedType: "COLOR",
      valuesByMode: { "1:0": "#2563EB", "1:1": "#3B82F6" }
    },
    {
      name: "spacing/md",
      resolvedType: "FLOAT",
      valuesByMode: { "1:0": 16 }
    }
  ]
})
```

**Usage (action: "update"):**
```javascript
figma_batch_variables({
  action: "update",
  updates: [
    { variableId: "VariableID:1:1", modeId: "1:0", value: "#2563EB" },
    { variableId: "VariableID:1:2", modeId: "1:0", value: "#1D4ED8" },
    { variableId: "VariableID:1:3", modeId: "1:0", value: 20 }
  ]
})
```

**Usage (action: "setup"):**
```javascript
figma_batch_variables({
  action: "setup",
  collectionName: "Brand Tokens",
  modes: ["Light", "Dark"],
  tokens: [
    {
      name: "color/background",
      resolvedType: "COLOR",
      description: "Page background",
      values: { "Light": "#FFFFFF", "Dark": "#1A1A2E" }
    },
    {
      name: "color/text",
      resolvedType: "COLOR",
      values: { "Light": "#111827", "Dark": "#F9FAFB" }
    },
    {
      name: "spacing/page",
      resolvedType: "FLOAT",
      values: { "Light": 24, "Dark": 24 }
    }
  ]
})
```

**Parameters:**
- `action` (required): `"create"`, `"update"`, or `"setup"`
- For `"create"`:
  - `collectionId` (required): Collection ID to create all variables in
  - `variables` (required): Array of 1-100 variable definitions, each with:
    - `name` (required): Variable name (use `/` for grouping)
    - `resolvedType` (required): `"COLOR"`, `"FLOAT"`, `"STRING"`, or `"BOOLEAN"`
    - `description` (optional): Variable description
    - `valuesByMode` (optional): Object mapping mode IDs to values
- For `"update"`:
  - `updates` (required): Array of 1-100 updates, each with:
    - `variableId` (required): Variable ID to update
    - `modeId` (required): Mode ID to update value in
    - `value` (required): New value (COLOR: hex `"#FF0000"`, FLOAT: number, STRING: text, BOOLEAN: true/false)
- For `"setup"`:
  - `collectionName` (required): Name for the new collection
  - `modes` (required): Array of 1-4 mode names (first becomes default)
  - `tokens` (required): Array of 1-100 token definitions, each with:
    - `name` (required): Token name (use `/` for grouping)
    - `resolvedType` (required): `"COLOR"`, `"FLOAT"`, `"STRING"`, or `"BOOLEAN"`
    - `description` (optional): Token description
    - `values` (required): Object mapping **mode names** (not IDs) to values

**Returns (setup):**
```json
{
  "success": true,
  "message": "Created collection 'Brand Tokens' with 2 modes and 3 tokens (0 failed)",
  "collectionId": "VariableCollectionId:1:1",
  "collectionName": "Brand Tokens",
  "modes": { "Light": "1:0", "Dark": "1:1" },
  "created": 3,
  "failed": 0,
  "results": [
    { "success": true, "name": "color/background", "id": "VariableID:1:1" },
    { "success": true, "name": "color/text", "id": "VariableID:1:2" },
    { "success": true, "name": "spacing/page", "id": "VariableID:1:3" }
  ]
}
```

**Key Note for "setup":** Values are keyed by **mode name** (e.g., `"Light"`, `"Dark"`) instead of mode ID — the tool resolves names to IDs internally.

**Returns (create):**
```json
{
  "success": true,
  "message": "Batch created 3 variables (0 failed)",
  "created": 3,
  "failed": 0,
  "results": [
    { "success": true, "name": "colors/primary/500", "id": "VariableID:1:1" },
    { "success": true, "name": "colors/primary/600", "id": "VariableID:1:2" },
    { "success": true, "name": "spacing/md", "id": "VariableID:1:3" }
  ]
}
```

**Returns (update):**
```json
{
  "success": true,
  "message": "Batch updated 3 variables (0 failed)",
  "updated": 3,
  "failed": 0,
  "results": [
    { "success": true, "variableId": "VariableID:1:1", "name": "colors/primary/500" },
    { "success": true, "variableId": "VariableID:1:2", "name": "colors/primary/600" },
    { "success": true, "variableId": "VariableID:1:3", "name": "spacing/md" }
  ]
}
```

**Performance:** Executes in a single CDP roundtrip. 10-50x faster than individual calls for bulk operations.

---

### `figma_setup_design_tokens` (Removed)

> **Consolidated into `figma_batch_variables(action: "setup")`**. See [figma_batch_variables](#figma_batch_variables) above.

---

## 🧩 Component Tools (Local Mode Only)

> **⚠️ Requires Desktop Bridge Plugin**: These tools only work in Local Mode with the Desktop Bridge plugin running in Figma.

### `figma_find_components`

Unified component search tool — find components by name, get detailed component information, retrieve component keys for instantiation, or get a high-level design system overview.

**When to Use:**
- Finding existing components to instantiate
- Discovering available UI building blocks
- Checking if a component already exists before creating
- Getting detailed component properties, variants, and metadata
- Retrieving component keys for instantiation
- Getting a high-level overview of the design system (replaces the former `figma_get_design_system_summary`)

**Usage (search):**
```javascript
figma_find_components({
  query: "Button",           // Search term
  includeDescription: true   // Include description in results
})
```

**Usage (details):**
```javascript
figma_find_components({
  componentKey: "abc123def456",  // Component key from search results
  verbosity: "details"
})
```

**Usage (keys):**
```javascript
figma_find_components({
  query: "Button",
  verbosity: "keys"
})
```

**Usage (overview):**
```javascript
figma_find_components({
  verbosity: "overview"
})
```

**Parameters:**
- `query` (optional): Search term to match against component names
- `componentKey` (optional): The component's key identifier (for details lookup)
- `verbosity` (optional): Level of detail — `"summary"` (default search), `"details"` (full component info), `"keys"` (component keys for instantiation), or `"overview"` (high-level design system summary)
- `includeDescription` (optional): Include component descriptions (default: true)

**Returns:**
- At `"summary"` verbosity: Array of matching components with ID, name, key, and description
- At `"details"` verbosity: Full component details including properties, variants, and metadata
- At `"keys"` verbosity: Component keys suitable for use with `figma_instantiate_component`
- At `"overview"` verbosity: High-level design system summary including component count and categories, variable collections and counts, style summary, and page structure overview

---

### `figma_instantiate_component`

Create an instance of a component on the canvas.

**When to Use:**
- Adding existing components to your design
- Building compositions from component library
- Creating layouts using design system components

**Usage:**
```javascript
figma_instantiate_component({
  componentKey: "abc123def456",
  x: 100,                        // X position
  y: 200,                        // Y position
  overrides: {                   // Property overrides
    "Button Label": "Click Me",
    "Show Icon": true
  }
})
```

**Parameters:**
- `componentKey` (required): Component key to instantiate
- `x` (optional): X position on canvas
- `y` (optional): Y position on canvas
- `overrides` (optional): Property overrides for the instance

**Returns:**
- Created instance with node ID

---

### `figma_arrange_component_set`

Organize component variants into a professional component set with labels and proper structure.

**When to Use:**
- After creating multiple component variants
- Organizing messy component sets
- Adding row/column labels to variant grids
- Getting the purple dashed border Figma styling

**Usage:**
```javascript
figma_arrange_component_set({
  componentSetId: "123:456",     // Component set to arrange
  options: {
    gap: 24,                     // Gap between cells
    cellPadding: 20,             // Padding inside cells
    columnProperty: "State"      // Property to use for columns
  }
})
```

**Parameters:**
- `componentSetId` (optional): ID of component set to arrange (uses selection if not provided)
- `componentSetName` (optional): Find component set by name
- `options` (optional): Layout options
  - `gap`: Gap between grid cells (default: 24)
  - `cellPadding`: Padding inside each cell (default: 20)
  - `columnProperty`: Property to use for columns (default: auto-detect, usually "State")

**Returns:**
- Arranged component set with:
  - White container frame with title
  - Row labels (vertically centered)
  - Column headers (horizontally centered)
  - Purple dashed border (Figma's native styling)

**Example Result:**
```
┌─────────────────────────────────────────┐
│  Button                                 │
│         Default  Hover  Pressed  Disabled
│  ┌─────────────────────────────────────┐
│  │ Primary/Small  [btn] [btn] [btn] [btn]
│  │ Primary/Medium [btn] [btn] [btn] [btn]
│  │ Primary/Large  [btn] [btn] [btn] [btn]
│  │ Secondary/...  [btn] [btn] [btn] [btn]
│  └─────────────────────────────────────┘
└─────────────────────────────────────────┘
```

---

### `figma_set_description` (Removed)

> **Consolidated into `figma_component_property(action: "set_description")`**. See [Component Property Tools](#-component-property-tools-local-mode-only) below.

---

## 🔧 Node Manipulation Tools (Local Mode Only)

### `figma_edit_node`

Unified node manipulation tool — resize, move, clone, delete, rename, reparent, or reorder nodes using an action-based interface.

**Usage:**
```javascript
// Resize a node
figma_edit_node({
  action: "resize",
  nodeId: "123:456",
  width: 200,
  height: 100
})

// Move a node
figma_edit_node({
  action: "move",
  nodeId: "123:456",
  x: 100,
  y: 200
})

// Clone a node
figma_edit_node({
  action: "clone",
  nodeId: "123:456"
})

// Delete a node
figma_edit_node({
  action: "delete",
  nodeId: "123:456"
})

// Rename a node
figma_edit_node({
  action: "rename",
  nodeId: "123:456",
  newName: "Header Section"
})
```

**Parameters:**
- `action` (required): `"resize"`, `"move"`, `"clone"`, `"delete"`, `"rename"`, `"reparent"`, or `"reorder"`
- `nodeId` (required): Node ID to operate on
- For `"resize"`: `width`, `height`
- For `"move"`: `x`, `y`
- For `"rename"`: `newName`
- For `"reparent"`: `parentId`, `index` (optional)
- For `"reorder"`: `index`

**Returns:**
- Action-specific result (e.g., new node ID for clone, confirmation for delete)

**Warning:** The `"delete"` action cannot be undone programmatically.

---

### `figma_set_text`

Set the text content of a text node.

**Usage:**
```javascript
figma_set_text({
  nodeId: "123:456",
  characters: "Hello World"
})
```

---

### `figma_set_appearance`

Set visual appearance properties of a node — fills, strokes, opacity, cornerRadius, effects, rotation, and blendMode.

**Usage:**
```javascript
// Set fill colors
figma_set_appearance({
  nodeId: "123:456",
  fills: [{ type: "SOLID", color: "#FF0000" }]
})

// Set stroke colors
figma_set_appearance({
  nodeId: "123:456",
  strokes: [{ type: "SOLID", color: "#000000" }],
  strokeWeight: 2
})

// Set multiple appearance properties at once
figma_set_appearance({
  nodeId: "123:456",
  fills: [{ type: "SOLID", color: "#3B82F6" }],
  opacity: 0.9,
  cornerRadius: 8,
  rotation: 15,
  blendMode: "MULTIPLY"
})
```

**Parameters:**
- `nodeId` (required): Node ID to modify
- `fills` (optional): Array of fill paint objects
- `strokes` (optional): Array of stroke paint objects
- `strokeWeight` (optional): Stroke weight in pixels
- `opacity` (optional): Node opacity (0-1)
- `cornerRadius` (optional): Corner radius in pixels
- `effects` (optional): Array of effect objects (shadows, blurs)
- `rotation` (optional): Rotation in degrees
- `blendMode` (optional): Blend mode (NORMAL, MULTIPLY, SCREEN, OVERLAY, etc.)

---

### `figma_create_child`

Create a child node inside a parent.

**Usage:**
```javascript
figma_create_child({
  parentId: "123:456",
  type: "FRAME",
  name: "New Frame"
})
```

---

## 🏷️ Component Property Tools (Local Mode Only)

### `figma_add_component_property`

Add a new property to a component.

**Usage:**
```javascript
figma_add_component_property({
  nodeId: "123:456",
  propertyName: "Show Icon",
  propertyType: "BOOLEAN",
  defaultValue: true
})
```

**Parameters:**
- `nodeId` (required): Component node ID
- `propertyName` (required): Name for the new property
- `propertyType` (required): `"BOOLEAN"`, `"TEXT"`, `"INSTANCE_SWAP"`, or `"VARIANT"`
- `defaultValue` (required): Default value for the property

---

### `figma_edit_component_property`

Edit an existing component property.

**Usage:**
```javascript
figma_edit_component_property({
  nodeId: "123:456",
  propertyName: "Label",
  newValue: {
    name: "Button Text",
    defaultValue: "Click me"
  }
})
```

---

### `figma_delete_component_property`

Remove a property from a component.

**Usage:**
```javascript
figma_delete_component_property({
  nodeId: "123:456",
  propertyName: "Deprecated Prop"
})
```

---

### `figma_component_property`

Unified component property tool — currently supports setting descriptions on components, component sets, or styles.

**When to Use:**
- Documenting components for developers
- Adding usage guidelines
- Writing design system documentation

**Usage (set_description):**
```javascript
figma_component_property({
  action: "set_description",
  nodeId: "123:456",
  description: "Primary action button. Use for main CTAs.\n\n**Variants:**\n- Size: Small, Medium, Large\n- State: Default, Hover, Pressed, Disabled"
})
```

**Parameters:**
- `action` (required): `"set_description"`
- `nodeId` (required): Node ID of component/style to document
- `description` (required): Description text (supports markdown)

**Returns:**
- Confirmation with updated node info

**Note:** Descriptions appear in Figma's Dev Mode for developers.

---

## 📊 Design System Summary Tools (Consolidated)

### `figma_get_design_system_summary` (Removed)

> **Consolidated into `figma_find_components(verbosity: "overview")`**. See [figma_find_components](#figma_find_components) above.

### `figma_get_token_values` (Removed)

> **Removed.** Use `figma_get_variables(format="summary")` for variable values by collection and mode, or `figma_find_components(verbosity: "overview")` for a high-level design system overview.

---

## AI Decision Guide: Which Tool to Use?

### For Design Creation

| Task | Tool | Example |
|------|------|---------|
| Resize, move, clone, delete nodes | `figma_edit_node` | Layout adjustments, duplication |
| Set fills, strokes, effects, opacity | `figma_set_appearance` | Visual styling |
| Create child nodes | `figma_create_child` | Building frames |
| Set text content | `figma_set_text` | Labels, headings, paragraphs |
| Arrange component variants | `figma_arrange_component_set` | Organize variant grids |
| Manage pages | `figma_manage_page` | Create, rename, reorder pages |

### For Variable Management

| Task | Tool |
|------|------|
| Create new token collection | `figma_create_variable_collection` |
| Add a single design token | `figma_create_variable` |
| Add multiple design tokens (3+) | `figma_batch_variables` (action: "create") |
| Change a single token value | `figma_update_variable` |
| Change multiple token values (3+) | `figma_batch_variables` (action: "update") |
| Set up a full token system from scratch | `figma_batch_variables` (action: "setup") |
| Reorganize token names | `figma_rename_variable` |
| Remove tokens | `figma_delete_variable` |
| Add themes (Light/Dark) | `figma_add_mode` |
| Rename themes | `figma_rename_mode` |

### For Design-Code Parity

| Task | Tool |
|------|------|
| Compare Figma specs against code | `figma_check_design_parity` |
| Generate component documentation | `figma_generate_component_doc` |
| Audit component before sign-off | `figma_check_design_parity` |
| Create design system reference docs | `figma_generate_component_doc` |
| Notify designers of parity drift | `figma_comments` (action: "post") |
| Review existing feedback threads | `figma_comments` (action: "get") |
| Clean up resolved feedback | `figma_comments` (action: "delete") |

### Prerequisites Checklist

Before using write tools, ensure:
1. ✅ Connected to Figma Desktop via **Desktop Bridge Plugin** (recommended) or CDP debug mode (alternative)
2. ✅ **Desktop Bridge plugin** is running in your Figma file
3. ✅ `figma_get_status` returns `setup.valid: true`

---

## 🔍 Design-Code Parity Tools

### `figma_check_design_parity`

Compare a Figma component's design specs against your code implementation. Produces a scored parity report with actionable fix items.

**When to Use:**
- Before sign-off on a component implementation
- During design system audits to catch drift between design and code
- To verify that code accurately reflects the design spec

**Usage:**
```javascript
figma_check_design_parity({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '695:313',
  codeSpec: {
    visual: {
      backgroundColor: '#FFFFFF',
      borderColor: '#E4E4E7',
      borderRadius: 12,
      opacity: 1
    },
    spacing: {
      paddingTop: 24,
      paddingRight: 24,
      paddingBottom: 24,
      paddingLeft: 24,
      gap: 24
    },
    componentAPI: {
      props: [
        { name: 'className', type: 'string', required: false },
        { name: 'children', type: 'ReactNode', required: false }
      ]
    },
    metadata: {
      name: 'Card',
      filePath: 'src/components/card/card.tsx'
    }
  },
  canonicalSource: 'design',
  enrich: true
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL (uses current URL if omitted)
- `nodeId` (required): Component node ID
- `codeSpec` (required): Structured code-side data with sections:
  - `visual`: backgroundColor, borderColor, borderRadius, opacity, shadow, etc.
  - `spacing`: paddingTop/Right/Bottom/Left, gap, width, height, minWidth, maxWidth
  - `typography`: fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, color
  - `tokens`: usedTokens array, hardcodedValues array, tokenCoverage percentage
  - `componentAPI`: props array (name, type, required, defaultValue, description)
  - `accessibility`: role, ariaLabel, keyboardInteraction, focusManagement, contrastRatio
  - `metadata`: name, filePath, version, status, tags, description
- `canonicalSource` (optional): Which source is truth — `"design"` (default) or `"code"`
- `enrich` (optional): Enable token/enrichment analysis (default: true)

**Returns:**
- `summary`: Total discrepancies, parity score (0-100), counts by severity (critical/major/minor/info), categories breakdown
- `discrepancies`: Array of property mismatches with category, severity, design value, code value, and suggestion
- `actionItems`: Structured fix instructions specifying which side to fix, which Figma tool or code change to apply
- `designData`: Raw Figma data extracted from the component (fills, strokes, spacing, properties)
- `codeData`: The codeSpec as provided
- `ai_instruction`: Structured presentation guide for consistent report formatting

**Parity Score:**
`score = max(0, 100 - (critical×15 + major×8 + minor×3 + info×1))`

**COMPONENT_SET Handling:**
When given a COMPONENT_SET node, the tool automatically resolves to the default variant (first child) for visual comparisons (fills, strokes, spacing, typography). Component property definitions and naming are read from the COMPONENT_SET itself.

---

### `figma_generate_component_doc`

Generate platform-agnostic markdown documentation for a component by merging Figma design data with code-side info. Output is compatible with Docusaurus, Mintlify, ZeroHeight, Knapsack, Supernova, and any markdown-based docs platform.

**When to Use:**
- Generating design system component documentation
- Creating developer handoff documentation
- Building a component reference library

**Usage:**
```javascript
figma_generate_component_doc({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '695:313',
  codeInfo: {
    importStatement: "import { Button } from '@mylib/ui'",
    props: [
      { name: 'variant', type: "'primary' | 'secondary' | 'ghost'", required: false, defaultValue: "'primary'", description: 'Visual style variant' },
      { name: 'size', type: "'sm' | 'md' | 'lg'", required: false, defaultValue: "'md'", description: 'Button size' }
    ],
    events: [
      { name: 'onClick', payload: 'React.MouseEvent<HTMLButtonElement>', description: 'Fires when clicked' }
    ],
    usageExamples: [
      { title: 'Basic', code: '<Button>Click me</Button>' },
      { title: 'Destructive', code: '<Button variant="destructive"><Trash2 /> Delete</Button>' }
    ]
  },
  systemName: 'MyDesignSystem',
  includeFrontmatter: true,
  enrich: true
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL (uses current URL if omitted)
- `nodeId` (required): Component node ID
- `codeInfo` (optional): Code-side documentation info:
  - `importStatement`: Import path
  - `props`: Array of prop definitions (name, type, required, defaultValue, description)
  - `events`: Array of event definitions
  - `slots`: Array of slot/sub-component definitions
  - `usageExamples`: Array of code examples (title + code)
  - `changelog`: Version history entries
- `sections` (optional): Toggle individual sections on/off (overview, statesAndVariants, visualSpecs, implementation, accessibility, changelog)
- `outputPath` (optional): Suggested file path for saving
- `systemName` (optional): Design system name for documentation headers
- `enrich` (optional): Enable enrichment analysis (default: true)
- `includeFrontmatter` (optional): Include YAML frontmatter metadata (default: true)

**Returns:**
- `componentName`: Resolved component name
- `markdown`: Complete markdown documentation with frontmatter, overview, states & variants, visual specs, implementation, accessibility sections
- `includedSections`: Which sections were generated
- `dataSourceSummary`: What data sources were available (Figma enriched, code info, variables, styles)
- `suggestedOutputPath`: Where to save the file
- `ai_instruction`: Guidance for the AI on next steps (saving file, asking user for path)

**COMPONENT_SET Handling:**
Same as parity checker — resolves to default variant for visual specs, reads property definitions from the COMPONENT_SET.

---

## 💬 Comment Tools

### `figma_comments`

Unified comment tool — get, post, or delete comments on a Figma file.

**When to Use:**
- Reviewing feedback threads on a design file
- Checking for open comments before a release
- Posting feedback pinned to specific components (e.g., after `figma_check_design_parity`)
- Replying to existing comment threads
- Cleaning up resolved or outdated comments

**Usage (action: "get"):**
```javascript
figma_comments({
  action: "get",
  fileUrl: 'https://figma.com/design/abc123',
  include_resolved: false,
  as_md: true
})
```

**Usage (action: "post"):**
```javascript
// Pin a comment to a specific node
figma_comments({
  action: "post",
  fileUrl: 'https://figma.com/design/abc123',
  message: 'Border-radius in code uses 8px but Figma shows 6px. Please update.',
  node_id: '695:313'
})

// Reply to an existing comment thread
figma_comments({
  action: "post",
  fileUrl: 'https://figma.com/design/abc123',
  message: 'Fixed in the latest push.',
  reply_to_comment_id: '1627922741'
})
```

**Usage (action: "delete"):**
```javascript
figma_comments({
  action: "delete",
  fileUrl: 'https://figma.com/design/abc123',
  comment_id: '1627922741'
})
```

**Parameters:**
- `action` (required): `"get"`, `"post"`, or `"delete"`
- `fileUrl` (optional): Figma file URL (uses current URL if omitted)
- For `"get"`:
  - `as_md` (optional): Return comment message bodies as markdown (default: false)
  - `include_resolved` (optional): Include resolved comment threads (default: false)
- For `"post"`:
  - `message` (required): The comment message text
  - `node_id` (optional): Node ID to pin the comment to (e.g., `'695:313'`)
  - `x` (optional): X offset for comment placement relative to the node
  - `y` (optional): Y offset for comment placement relative to the node
  - `reply_to_comment_id` (optional): ID of an existing comment to reply to
- For `"delete"`:
  - `comment_id` (required): The ID of the comment to delete (get IDs from `figma_comments` with action `"get"`)

**Returns (get):**
- `comments`: Array of comment objects with `id`, `message`, `user`, `created_at`, `resolved_at`, `client_meta` (pinned location)
- `summary`: Total, active, resolved, and returned counts

**Returns (post):**
- `comment`: Created comment object with `id`, `message`, `created_at`, `user`, `client_meta`

**Returns (delete):**
- `success`: Boolean indicating deletion success
- `deleted_comment_id`: The ID that was deleted

<Warning>
**@mentions are not supported via the API.** Including `@name` in the message renders as plain text, not a clickable Figma mention tag. Clickable @mentions with notifications are a Figma UI-only feature. To notify specific people, share the comment link or use Figma's built-in notification system.
</Warning>

---

## Error Handling

All tools return structured error responses:

```json
{
  "error": "Error message",
  "message": "Human-readable description",
  "hint": "Suggestion for resolution"
}
```

Common errors:
- `"FIGMA_ACCESS_TOKEN not configured"` - Set up your token (see installation guide)
- `"Failed to connect to browser"` - Browser initializing or connection issue
- `"Invalid Figma URL"` - Check URL format
- `"Node not found"` - Verify node ID is correct
- `"Desktop Bridge plugin not found"` - Ensure plugin is running in Figma
- `"Invalid hex color"` - Check hex format (use #RGB, #RGBA, #RRGGBB, or #RRGGBBAA)

See [Troubleshooting Guide](TROUBLESHOOTING.md) for detailed solutions.
