# Figma Console MCP - Project Context

## Project Overview

**Name:** Figma Console MCP
**Type:** Model Context Protocol (MCP) Server
**Language:** TypeScript
**Runtime:** Node.js >= 18

## Purpose

Enable AI coding assistants (Claude Code, Cursor, etc.) to interact with Figma in real-time through a two-tier architecture:

1. **REST API Mode** - Read-only access to Figma file data, components, variables, and styles
2. **Desktop Bridge Mode** - Full read/write access via a Figma plugin that executes commands locally

## Key Technologies

- **@modelcontextprotocol/sdk** - MCP protocol implementation
- **Puppeteer / Chrome DevTools Protocol** - Browser automation for console capture
- **Figma Plugin API** - Design manipulation via Desktop Bridge
- **TypeScript** - Type-safe development
- **Biome** - Formatting and linting
- **Jest** - Testing framework

## Architecture

### Local Mode (Desktop Bridge)
- Connects to Figma Desktop via plugin
- Full read/write capabilities via specialized tools
- REST API for read-only design system extraction

## Core Tool Categories

### Console & Debugging
- `figma_get_console_logs` - Retrieve plugin console output
- `figma_take_screenshot` - Capture plugin UI
- `figma_watch_console` - Stream logs in real-time
- `figma_reload_plugin` - Reload after code changes

### Design System (Read)
- `figma_get_file_data` - File structure and metadata
- `figma_get_variables` - Design tokens and variables
- `figma_get_component` - Component definitions
- `figma_get_styles` - Color, text, effect styles

### Design Manipulation (Desktop Bridge)
- `figma_edit_node` - Resize, move, clone, delete, rename, reparent, reorder nodes
- `figma_set_appearance` - Fills, strokes, opacity, corner radius, effects, rotation
- `figma_create_nodes` - Create nodes or entire node trees in frames
- `figma_set_text` - Text content and typography
- `figma_set_reaction` - Prototyping interactions
- Component property management tools

## Development Workflow

1. Write code → Follow MCP SDK patterns
2. Format → `npm run format`
3. Lint → `npm run lint:fix`
4. Test → `npm test`
5. Build → `npm run build`

## References

- [README](../README.md) - Setup and usage
- [docs/](../docs/) - Detailed documentation
