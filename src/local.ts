#!/usr/bin/env node

/**
 * Figma Console MCP Server - Local Mode
 *
 * Entry point for local MCP server that connects to Figma Desktop
 * via Chrome Remote Debugging Protocol (port 9222).
 *
 * This implementation uses stdio transport for MCP communication,
 * suitable for local IDE integrations and development workflows.
 *
 * Requirements:
 * - Figma Desktop must be launched with: --remote-debugging-port=9222
 * - "Use Developer VM" enabled in Figma: Plugins → Development → Use Developer VM
 * - FIGMA_ACCESS_TOKEN environment variable for API access
 *
 * macOS launch command:
 *   open -a "Figma" --args --remote-debugging-port=9222
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { realpathSync, existsSync } from "fs";
import { LocalBrowserManager } from "./browser/local.js";
import { ConsoleMonitor } from "./core/console-monitor.js";
import { getConfig } from "./core/config.js";
import { createChildLogger } from "./core/logger.js";
import {
	FigmaAPI,
	extractFigmaUrlInfo,
	formatVariables,
} from "./core/figma-api.js";
import { registerFigmaAPITools } from "./core/figma-tools.js";
import { registerBatchTool } from "./core/batch-tool.js";
import { SessionCache, CachedFigmaAPI } from "./core/session-cache.js";
import { ProjectContextCache } from "./core/project-context.js";
import { TeamLibraryCache } from "./core/team-library.js";
import { registerContextResources } from "./core/context-resources.js";
import { FigmaDesktopConnector } from "./core/figma-desktop-connector.js";
import type { IFigmaConnector } from "./core/figma-connector.js";
import { FigmaWebSocketServer } from "./core/websocket-server.js";
import { WebSocketConnector } from "./core/websocket-connector.js";
import {
	DEFAULT_WS_PORT,
	getPortRange,
	advertisePort,
	unadvertisePort,
	registerPortCleanup,
	cleanupStalePortFiles,
} from "./core/port-discovery.js";
import { registerTokenBrowserApp } from "./apps/token-browser/server.js";
import { registerDesignSystemDashboardApp } from "./apps/design-system-dashboard/server.js";
import {
	registerConnectionTools,
	registerVariableTools,
	registerComponentTools,
	registerNodeTools,
} from "./local-tools/index.js";
import type { LocalToolDeps } from "./local-tools/types.js";

const logger = createChildLogger({ component: "local-server" });

/**
 * Local MCP Server
 * Connects to Figma Desktop and provides all MCP tools
 */
class LocalFigmaConsoleMCP {
	private server: McpServer;
	private browserManager: LocalBrowserManager | null = null;
	private consoleMonitor: ConsoleMonitor | null = null;
	private figmaAPI: FigmaAPI | null = null;
	private desktopConnector: IFigmaConnector | null = null;
	private wsServer: FigmaWebSocketServer | null = null;
	private wsStartupError: { code: string; port: number } | null = null;
	/** The port the WebSocket server actually bound to (may differ from preferred if fallback occurred) */
	private wsActualPort: number | null = null;
	/** The preferred port requested (from env var or default) */
	private wsPreferredPort: number = DEFAULT_WS_PORT;
	private config = getConfig();

	// In-memory cache for variables data to avoid MCP token limits
	// Maps fileKey -> {data, timestamp}
	private variablesCache: Map<
		string,
		{
			data: any;
			timestamp: number;
		}
	> = new Map();

	// Session-scoped API cache (Layer 3) — deduplicates read-only Figma API calls
	private sessionCache = new SessionCache();
	// Disk-persistent project context cache (Layer 1) — survives server restarts
	private projectContextCache = new ProjectContextCache();
	// Team library cache — team-wide published component/style catalog
	private teamLibraryCache = new TeamLibraryCache();
	// Named design systems: name → team ID (from FIGMA_DESIGN_SYSTEMS or FIGMA_TEAM_ID)
	private designSystems: Map<string, string> = new Map();

	constructor() {
		this.server = new McpServer(
			{
				name: "Figma Console MCP (Local)",
				version: "0.1.0",
			},
			{
				instructions: `## Figma Console MCP — Tool Reference & Workflow Guide

### MCP Resources (read before making tool calls)
Cached resources provide instant project context — check first:
- figma://context/current — file overview: pages, component counts, variable collections, styles. Read at session start.
- figma://context/{fileKey} — full context for a specific file.
- figma://context/{fileKey}/components — component inventory.
- figma://context/{fileKey}/tokens — variable collections and token summary.
- figma://context/{fileKey}/styles — style summary (paint, text, effect).
- figma://context/library — team design system library catalog (if FIGMA_DESIGN_SYSTEMS configured).

### Session Start
1. Read figma://context/current — instant file overview.
2. figma_connection action='navigate' — open a Figma URL or switch files. Use this as your first tool call.
3. figma_context — consolidated design system overview (components, variables, styles) in one call. This determines your palette, typography, and building blocks.
4. figma_inspect — deep-inspect a node. Omit nodeId to inspect current selection (includes otherSelected for multi-select).
5. figma_get_viewport — see what's visible in the canvas without requiring selection.

---

### Tools: Read
- figma_inspect — the primary read tool. Deep node inspection with data stripping. Falls back to selection.
- figma_context — design system overview from cache: components, variables, styles.
- figma_find_node — search current page by name/type. Use to locate nodes before inspecting.
- figma_get_component — single component detail (metadata | reconstruction | development format).
- figma_find_components — search/browse components: keys → summary → details. Use figma_context for overview.
- figma_get_variables — design tokens with code export (CSS/Tailwind/Sass/TS). Use figma_context for summary.
- figma_get_styles — styles with code export. Use figma_context for summary.
- figma_get_library_components — search team's published library by name (needs FIGMA_DESIGN_SYSTEMS). Use targeted namePattern — empty string returns all components (potentially 500+).

### Tools: Write — Structure
- figma_edit_node — action: resize | move | clone | delete | rename | reparent | reorder | detach | focus. Resize supports SECTION nodes.
- figma_create_nodes — create a node or node tree inside a parent. Types: RECTANGLE, ELLIPSE, FRAME, COMPONENT, TEXT, LINE. COMPONENT = reusable/publishable. Not yet supported: SECTION, POLYGON, STAR, CONNECTOR, VECTOR.
- figma_manage_page — action: create | delete | rename | switch | reorder | list.

### Tools: Write — Visuals
- figma_set_appearance — fills, strokes, opacity, cornerRadius, effects, rotation, blendMode, fillStyleId, strokeStyleId, effectStyleId, variableBindings. Color format: hex '#FF0000' or '#FF000080' (with alpha).
- figma_set_text — content + typography (font, size, alignment, spacing, decoration, case) + textStyleId + variableBindings + hyperlinks (type "URL" for web links, "NODE" for Figma deep-links).
- figma_set_layout — auto-layout (flexbox) or CSS grid. Padding, gap, alignment, wrap, variableBindings for spacing tokens.

### Tools: Write — Components
- figma_instantiate_component — create instance. Pass both componentKey and nodeId together. Overrides param handles TEXT and BOOLEAN only — not INSTANCE_SWAP.
- figma_set_instance_properties — update instance props: TEXT, BOOLEAN, VARIANT, INSTANCE_SWAP. The only way to change instance content — direct text/fill edits on instances silently fail.
- figma_component_property — action: add | edit | delete | wire | set_description. For TEXT properties, pass targetNodeId with add to auto-wire. Use wire action to connect properties to layers ('characters' for text, 'visible' for boolean, 'mainComponent' for instance swap).
- figma_arrange_component_set — organize variant grid with Figma's native purple-dashed layout.
- figma_combine_as_variants — combine components into a variant set. Strokes on child components are preserved through the combine operation.

### Tools: Write — Variables & Tokens
- figma_variable_operation — single mutation. action: update_value | create | create_collection | delete | rename | add_mode | rename_mode.
- figma_batch_variables — bulk ops, 10-50x faster. action: create | update | setup (collection + modes + variables atomically).

### Tools: Write — Styles & Prototyping
- figma_create_style — action: create | update | delete | list. Paint, text, effect styles.
- figma_set_reaction — action: add | remove | list. Prototyping triggers, actions, transitions.

### Tools: Observe & Debug
- figma_screenshot — capture live state (source='plugin') or REST render (source='api'). Returns base64. Call standalone, not inside figma_batch (payload too large). Large nodes auto-downscaled to prevent export failures.
- figma_console — action: get (past logs) | watch (real-time stream) | clear.

### Tools: Connection
- figma_connection — action: navigate | status | reconnect | invalidate_cache | reload | list_files | changes.

### Tools: Multi-Tool
- figma_batch — up to 25 tools in one request. Best for reads and simple writes (edit, appearance, text on individual nodes). Avoid batching: complex nested figma_create_nodes, component instantiation with layout, multi-step component assembly, or figma_screenshot.

---

### Building Workflow

**Phase 1: Discover** (before touching anything)
1. Read figma://context/current.
2. figma_context — get variables, styles, components. These are your colors, typography, spacing. Don't copy hex values from existing nodes when design tokens exist.
3. If the user references a design or wireframe, translate its structure into the design system's visual language — don't replicate its exact colors/fonts.

**Phase 2: Test** (validate before scaling)
- When using a tool capability for the first time in a session, test on one node. Inspect the result. Then apply to all nodes.
- This catches silent failures early (e.g. style not applying, variable not binding).

**Phase 3: Build + Connect** (scaffold and bind tokens together)
- Create node trees with figma_create_nodes. Use auto-layout from the start.
- After creating nodes, apply text styles (textStyleId) and variable bindings (fills, strokes, spacing) in the same batch or the next call. Don't move on to creating more nodes while existing nodes have raw hex values.
- Pattern: create 1-3 nodes → apply styles/variables → create next batch → apply styles/variables. Not: create all nodes → try to remember which ones need tokens.
- A node is done when it has: textStyleId (if text), fill variable binding (if colored), stroke variable binding (if stroked), spacing variable bindings (if in auto-layout with token-based spacing).
- Batch independent operations with figma_batch.

**Phase 4: Verify**
- Screenshot at milestones only: (a) first component validates the pattern, (b) all components done (overview), (c) something looks wrong.
- Use figma_inspect for structural checks (much cheaper than screenshots).
- Max 2 fix iterations after screenshot, then ask the user.
- Run the Screenshot Self-Review Protocol on every screenshot (see figma_screenshot tool description). All 7 checks should pass before declaring "looks good."
- Common visual failures to watch for: text overflow/truncation, misaligned baselines, inconsistent spacing, cards too small (<200px), icons disproportionate to containers, placeholder content left in, stray 1px gaps between elements.

### Modifying Existing Designs
- Don't delete and rebuild when a modification was requested. Inspect existing → use set_* tools.
- Before editing: figma_inspect (omit nodeId = inspect selection), or figma_find_node to locate by name/type.
- To see recent changes (yours or user's): figma_connection action='changes'.
- Only use figma_create_nodes for genuinely new nodes.

---

### Style & Token System

**Two independent binding systems exist on every node:**
1. **Style bindings** (fillStyleId / textStyleId / effectStyleId / strokeStyleId): Reusable presets bundling multiple properties. A textStyleId sets font+size+weight+lineHeight together. Apply via figma_set_text textStyleId or figma_set_appearance fillStyleId/strokeStyleId/effectStyleId.
2. **Variable bindings** (variableBindings param): Individual design tokens bound to single properties (e.g. fills[0] → "Colors/Primary"). Apply via variableBindings on set_appearance/set_text/set_layout.
3. A node can have both — e.g. textStyleId for typography + a variable binding on its fill color.

**Style ID formats:**
- Local styles (created via figma_create_style): Use the returned style ID directly. Works immediately.
- Library/remote styles: Pass the style key (bare hash like "abc123..." or S: format like "S:abc123,1:2"). The plugin calls importStyleByKeyAsync internally to resolve the key to a local ID before applying. The style must be published to the team library.
- If a library style fails to apply: (a) verify the key via figma_get_styles or figma_context, (b) ensure the style is published, (c) try the bare hash format without S: prefix.

**Discovering resources:**
- figma_context — cached component/variable/style overview. Check first.
- figma_get_variables format='css'/'tailwind' — token code generation.
- figma_find_components verbosity='keys' query='Name' — cached keys for instantiation.
- figma_get_library_components namePattern='Name' — team library (60min TTL).
- Don't inspect random nodes to discover colors/fonts/tokens. The caches above have everything indexed.

**Text style + custom fill:** (1) figma_set_text with textStyleId, then (2) figma_set_appearance with fills. Style sets typography; fill override sticks.

### Layout Rules — Smart Defaults
Smart defaults apply to both figma_create_nodes and figma_set_layout:
- Auto-layout frames: HUG content both axes (primaryAxisSizingMode/counterAxisSizingMode = AUTO).
- strokesIncludedInLayout: true (CSS border-box behavior).
- Text nodes: auto-size (WIDTH_AND_HEIGHT) unless width set.
- Text inside auto-layout: FILL horizontal + HUG vertical (wraps to parent width).
- Child auto-layout frames inside auto-layout: HUG both axes.
- Shadow defaults: color=#00000040, offset={0,0}, radius=0 — only spread needed for focus rings.
- All defaults overridable by setting the property explicitly.
- Grid: children stack at cell (0,0) by default. Set gridColumnAnchorIndex + gridRowAnchorIndex on each child to position them.
- Creating a frame does not make it auto-layout. Set layoutMode explicitly.
- Frames/components default to clipsContent=true (matches Figma UI).
- Setting layoutMode resets sizing to HUG (AUTO). Re-set sizing after enabling auto-layout if you need FIXED sizing.
- Coordinates (x, y) are parent-relative. Children of SECTION nodes use section-relative coordinates — add section origin offset when calculating from page-absolute positions.

**Sizing properties — prefer the shorthand:**
- layoutSizingHorizontal / layoutSizingVertical: FIXED | HUG | FILL — maps directly to Figma UI dropdown. Use these.
- primaryAxisSizingMode / counterAxisSizingMode: FIXED | AUTO — low-level equivalents. AUTO = HUG. Still supported but less intuitive.
- layoutSizingHorizontal='FILL' on text nodes requires textAutoResize='HEIGHT' (auto-set by smart defaults).
- HUG = size determined by children. FILL = stretch to parent. FIXED = explicit width/height.

### Effects (Shadows, Blurs, Focus Rings)
- Drop shadow on a frame requires clipsContent=true to render. Without it, effects silently don't appear.
- Focus ring pattern: two DROP_SHADOW effects — (1) white, spread=2 (gap) on top, (2) blue, spread=4 (ring) underneath. Extends beyond frame bounds.
- Effects with spread don't affect layout sizing — purely visual.

### Component Instances & Variants
- INSTANCE_SWAP requires a separate figma_set_instance_properties call after instantiation (not supported in overrides param). The value can be a local node ID or a component key (40-char hex hash or S: format) — library components are auto-imported via importComponentByKeyAsync.
- For instances: use figma_set_instance_properties for content changes. Direct text/fill edits silently fail.
- figma_combine_as_variants preserves strokes on child components (snapshots and re-applies them after the combine operation).
- Keep variant dimensions similar within a component set. Wildly different sizes (wide+short vs narrow+tall) create ugly bounding boxes.
- Detached instances (figma_edit_node action='detach') don't inherit future main component changes. Creates new node IDs.
- When using figma_batch with component instantiation, compact mode includes instance IDs. Use verbose=true only for full objects.

### Design System Connection Pass
When creating new components/variants/custom UI, connect every layer to the design system as you build. Hardcoded values are brittle.

**The design system is a closed system.** Treat it as a constraint, not a suggestion:
- Every color, spacing, and typography value should come from figma_context / figma_get_variables. Don't invent token names or guess values.
- If a needed token doesn't exist (e.g. no "focus-ring-blue" variable), tell the user — don't silently hardcode a guess.
- After every 5+ creation calls, re-check figma_context to confirm you're still using correct token names/IDs (values can drift during a session).
- When translating a wireframe/mockup into a design system: extract the structure (layout, hierarchy, content) but derive all visual properties (colors, fonts, spacing, radii) from the DS tokens. The source design's visual style is irrelevant.

**Before building:** Run figma_context for available variables, styles, components.

**After scaffolding, connect every layer:**
1. **Text styles** — textStyleId via figma_set_text for every text node.
2. **Fill colors** — variableBindings via figma_set_appearance (e.g. "Colors/Surface").
3. **Stroke colors** — variableBindings via figma_set_appearance. A default paint is auto-created if the node has no strokes yet.
4. **Effect styles** — effectStyleId or bind shadow color to a variable.
5. **Spacing tokens** — variableBindings via figma_set_layout for padding, itemSpacing, cornerRadius.
6. **Text content** — string variables for labels that change per mode/theme.

**No layer left behind:**
- Every text node → textStyleId or variable bindings on font properties
- Every colored fill → variable binding (not raw hex)
- Every stroke → variable binding
- Every shadow/blur → effectStyleId or variable-bound color
- Every spacing value → variable binding if tokens exist
- Corner radii → variable binding if tokens exist

No variables/styles in the file? Use sensible hardcoded values — but tell the user the component isn't token-connected.

---

### Known Behaviors & Gotchas

**Paint auto-creation on bind:** When binding a variable to a paint slot that doesn't exist (e.g. stroke on a node with no strokes), a default solid black paint is auto-created at the target index. The variable binding then overrides its color. No need to add strokes/fills manually before binding.

**Font naming varies by family:** Inter uses "Semi Bold" (space), Open Sans uses "SemiBold" (no space). Must match the exact installed style name or text creation fails silently. When unsure, inspect an existing text node in that font.

**lineHeight consistency:** Mixing INTRINSIC (auto) with explicit percentages (e.g. 150%) in sibling text nodes causes baseline misalignment. Keep the format consistent.

**Node IDs are ephemeral:** Change across sessions, can change during operations (detach creates new IDs). Re-fetch at session start. After batch operations, verify nodes still exist before referencing them — nodes can vanish between operations. If an ID fails, re-find by name with figma_find_node.

**Sections:** Auto-expand to contain children but don't auto-shrink. After deleting content, sections retain their maximum-ever size. Use figma_edit_node action='resize' to manually shrink them.

**strokeCap:** Single property applying to both ends. No separate start/end control on LINE nodes. Per-vertex caps possible on VectorNodes via the vector network API only.

### Efficiency Rules

**Batch aggressively:** Use figma_batch for independent operations. 7 label creations at 3 calls each = 21 calls. Batched = 3 calls. Batch reads together and writes together.

**Screenshot sparingly:** Each screenshot carries a large base64 payload. Use figma_inspect for structural validation. Screenshot only at: (a) first component validates pattern, (b) all components done, (c) something looks wrong. Don't screenshot tiny elements (48x48 icons) — inspect them.

**Inspect efficiently:** One depth-2 figma_inspect + one overview screenshot to start. Don't do 25 individual inspections — batch with figma_batch or use figma_find_node for bulk discovery.

**Fail fast, pivot early:** If the same operation fails twice with different approaches, declare the limitation and ask the user. Don't burn 15+ tool calls chasing a broken path.

**Library fetches:** Use targeted namePattern. Empty pattern returns all components (potentially hundreds).

### UX/UI Quality Principles
When building UI in Figma, apply these principles — they're what separates "technically correct" from "looks shippable":
- **Visual hierarchy**: Size and weight signal importance. Headings > subheadings > body > captions. If everything is the same size, nothing is important.
- **Proximity groups**: Elements that belong together should be closer together than elements that don't. Card content has tight internal spacing; cards have wider spacing between them.
- **Consistent rhythm**: Pick a spacing scale (4px/8px base) and stick to it. Spacing should feel intentional, not random. Derive from design tokens when available.
- **Proportional sizing**: Components should be sized proportionally to their content and context. A button label of 3 words doesn't need a 400px-wide button. A card showing 4 lines of text shouldn't be 50px tall.
- **Alignment creates order**: Left-align text stacks. Center-align standalone labels. Don't mix alignment within a group unless there's a clear reason.
- **Minimum readable sizes**: Body text ≥12px, labels ≥11px, touch targets ≥44px, icons 16-24px for UI, 12-16px inline with text.
- **Contrast**: Text must be readable against its background. Dark text on light, or light text on dark. Avoid light-gray-on-white.

### Rules
- Don't leave nodes with hardcoded hex colors or missing textStyleId when design tokens/styles exist. If figma_context returned variables and styles, use them on every node. This is the most common quality failure.
- Node IDs are session-specific — don't reuse from a previous conversation.
- Use figma_find_node for discovery, figma_inspect for details. Avoid tree dumps.
- Place components inside a Section or Frame, not on bare canvas.
- Test tool capabilities on one node first before applying to many.
- figma_get_variables works via Desktop Bridge on all plans. REST API fallback for Enterprise.
- Verify file name before destructive operations when multiple files are connected.
- Keep stateful Figma tool operations in the main context — sub-agents lack session context and node IDs.`,
			},
		);
	}

	/**
	 * Get or create Figma API client
	 */
	private async getFigmaAPI(): Promise<FigmaAPI> {
		if (!this.figmaAPI) {
			const accessToken = process.env.FIGMA_ACCESS_TOKEN;

			if (!accessToken) {
				throw new Error(
					"FIGMA_ACCESS_TOKEN not configured. " +
						"Set it as an environment variable. " +
						"Get your token at: https://www.figma.com/developers/api#access-tokens",
				);
			}

			logger.info(
				{
					tokenPreview: `${accessToken.substring(0, 10)}...`,
					tokenLength: accessToken.length,
				},
				"Initializing Figma API with token from environment",
			);

			this.figmaAPI = new CachedFigmaAPI({ accessToken }, this.sessionCache);
		}

		return this.figmaAPI;
	}

	/**
	 * Get or create Desktop Connector for write operations.
	 * Tries WebSocket first (instant, no network timeout), falls back to CDP.
	 */
	private async getDesktopConnector(): Promise<IFigmaConnector> {
		// Try WebSocket first — instant check, no network timeout delay
		if (this.wsServer?.isClientConnected()) {
			try {
				const wsConnector = new WebSocketConnector(this.wsServer);
				await wsConnector.initialize();
				this.desktopConnector = wsConnector;
				logger.debug("Desktop connector initialized via WebSocket bridge");
				return this.desktopConnector;
			} catch (wsError) {
				const errorMsg = wsError instanceof Error ? wsError.message : String(wsError);
				logger.debug({ error: errorMsg }, "WebSocket connector init failed, trying CDP fallback");
			}
		}

		// CDP fallback (requires --remote-debugging-port=9222)
		try {
			await this.ensureInitialized();

			if (this.browserManager) {
				// Always get a fresh page reference to handle page navigation/refresh
				const page = await this.browserManager.getPage();

				// Always recreate the connector with the current page to avoid stale references
				// This prevents "detached Frame" errors when Figma page is refreshed
				const cdpConnector = new FigmaDesktopConnector(page);
				await cdpConnector.initialize();
				this.desktopConnector = cdpConnector;
				logger.debug("Desktop connector initialized via CDP with fresh page reference");
				return this.desktopConnector;
			}
		} catch (cdpError) {
			const errorMsg = cdpError instanceof Error ? cdpError.message : String(cdpError);
			logger.debug({ error: errorMsg }, "CDP connection also unavailable");
		}

		const wsPort = this.wsActualPort || this.wsPreferredPort || DEFAULT_WS_PORT;
		throw new Error(
			"Cannot connect to Figma Desktop.\n\n" +
			"Option 1 (WebSocket): Open the Desktop Bridge plugin in Figma.\n" +
			`  The plugin will connect automatically to ws://localhost:${wsPort}.\n` +
			"  No special launch flags needed.\n\n" +
			"Option 2 (CDP): Launch Figma with --remote-debugging-port=9222\n" +
			"  macOS: open -a \"Figma\" --args --remote-debugging-port=9222\n" +
			"  Windows: start figma://--remote-debugging-port=9222"
		);
	}

	/**
	 * Get the current Figma file URL from the best available source.
	 * Priority: CDP browser URL (full URL with branch/node info) → WebSocket file identity (synthesized URL).
	 * The synthesized URL is compatible with extractFileKey() and extractFigmaUrlInfo().
	 */
	private getCurrentFileUrl(): string | null {
		// Priority 1: CDP browser URL (full URL with branch/node info)
		const browserUrl = this.browserManager?.getCurrentUrl() || null;
		if (browserUrl) return browserUrl;

		// Priority 2: Synthesize URL from WebSocket file identity
		const wsFileInfo = this.wsServer?.getConnectedFileInfo() ?? null;
		if (wsFileInfo?.fileKey) {
			return `https://www.figma.com/design/${wsFileInfo.fileKey}/${encodeURIComponent(wsFileInfo.fileName || 'Untitled')}`;
		}

		return null;
	}

	/**
	 * Check if Figma Desktop is accessible via CDP or WebSocket
	 */
	private async checkFigmaDesktop(): Promise<void> {
		if (!this.config.local) {
			throw new Error("Local mode configuration missing");
		}

		const { debugHost, debugPort } = this.config.local;
		const browserURL = `http://${debugHost}:${debugPort}`;
		let cdpAvailable = false;

		try {
			// Simple HTTP check to see if debug port is accessible
			const response = await fetch(`${browserURL}/json/version`, {
				signal: AbortSignal.timeout(3000),
			});

			if (response.ok) {
				const versionInfo = await response.json();
				logger.info({ versionInfo, browserURL }, "Figma Desktop is accessible via CDP");
				cdpAvailable = true;
			}
		} catch {
			logger.debug("CDP not available at startup (this is OK if using WebSocket bridge)");
		}

		// Check WebSocket availability
		const wsAvailable = this.wsServer?.isClientConnected() ?? false;

		if (cdpAvailable && wsAvailable) {
			logger.info("Transport: Both CDP and WebSocket available (WebSocket preferred)");
		} else if (cdpAvailable) {
			logger.info("Transport: CDP available");
		} else if (wsAvailable) {
			logger.info("Transport: WebSocket bridge connected");
		} else {
			// Neither available yet — log guidance but don't throw
			// The user may open the plugin later
			logger.warn(
				`Neither CDP nor WebSocket transport available yet.\n\n` +
				`Option 1 (CDP): Launch Figma with --remote-debugging-port=${debugPort}\n` +
				`  macOS: open -a "Figma" --args --remote-debugging-port=${debugPort}\n\n` +
				`Option 2 (WebSocket): Open the Desktop Bridge plugin in Figma.\n` +
				`  No special launch flags needed — the plugin connects automatically.`,
			);
		}
	}

	/**
	 * Resolve the path to the Desktop Bridge plugin manifest.
	 * Works for both NPX installs (buried in npm cache) and local git clones.
	 */
	private getPluginPath(): string | null {
		try {
			const thisFile = fileURLToPath(import.meta.url);
			// From dist/local.js → go up to package root, then into figma-desktop-bridge
			const packageRoot = dirname(dirname(thisFile));
			const manifestPath = resolve(packageRoot, "figma-desktop-bridge", "manifest.json");
			return existsSync(manifestPath) ? manifestPath : null;
		} catch {
			return null;
		}
	}

	/**
	 * Auto-connect to Figma Desktop at startup
	 * Runs in background - never blocks or throws
	 * Enables "get latest logs" workflow without manual setup
	 */
	private autoConnectToFigma(): void {
		// Fire-and-forget with proper async handling
		(async () => {
			try {
				logger.info(
					"🔄 Auto-connecting to Figma Desktop for immediate log capture...",
				);
				await this.ensureInitialized();
				logger.info(
					"✅ Auto-connect successful - console monitoring active. Logs will be captured immediately.",
				);
			} catch (error) {
				// Don't crash - just log that auto-connect didn't work
				const errorMsg = error instanceof Error ? error.message : String(error);
				logger.warn(
					{ error: errorMsg },
					"⚠️ Auto-connect to Figma Desktop failed - will connect when you use a tool",
				);
				// This is fine - the user can still use tools to trigger connection later
			}
		})();
	}

	/**
	 * Initialize browser and console monitoring
	 */
	private async ensureInitialized(): Promise<void> {
		try {
			if (!this.browserManager) {
				logger.info("Initializing LocalBrowserManager");

				if (!this.config.local) {
					throw new Error("Local mode configuration missing");
				}

				this.browserManager = new LocalBrowserManager(this.config.local);
			}

			// Always check connection health (handles computer sleep/reconnects)
			if (this.browserManager && this.consoleMonitor) {
				const wasAlive = await this.browserManager.isConnectionAlive();
				await this.browserManager.ensureConnection();

				// 🆕 NEW: Dynamic page switching for worker migration
				// Check if we should switch to a page with more workers
				if (
					this.browserManager.isRunning() &&
					this.consoleMonitor.getStatus().isMonitoring
				) {
					const browser = (this.browserManager as any).browser;

					if (browser) {
						try {
							// Get all Figma pages
							const pages = await browser.pages();
							const figmaPages = pages
								.filter((p: any) => {
									const url = p.url();
									return url.includes("figma.com") && !url.includes("devtools");
								})
								.map((p: any) => ({
									page: p,
									url: p.url(),
									workerCount: p.workers().length,
								}));

							// Find current monitored page URL
							const currentUrl = this.browserManager.getCurrentUrl();
							const currentPageInfo = figmaPages.find(
								(p: { page: any; url: string; workerCount: number }) =>
									p.url === currentUrl,
							);
							const currentWorkerCount = currentPageInfo?.workerCount ?? 0;

							// Find best page (most workers)
							const bestPage = figmaPages
								.filter(
									(p: { page: any; url: string; workerCount: number }) =>
										p.workerCount > 0,
								)
								.sort(
									(
										a: { page: any; url: string; workerCount: number },
										b: { page: any; url: string; workerCount: number },
									) => b.workerCount - a.workerCount,
								)[0];

							// Switch if:
							// 1. Current page has 0 workers AND another page has workers
							// 2. Another page has MORE workers (prevent thrashing with threshold)
							const shouldSwitch =
								bestPage &&
								((currentWorkerCount === 0 && bestPage.workerCount > 0) ||
									bestPage.workerCount > currentWorkerCount + 1); // +1 threshold to prevent ping-pong

							if (shouldSwitch && bestPage.url !== currentUrl) {
								logger.info(
									{
										oldPage: currentUrl,
										oldWorkers: currentWorkerCount,
										newPage: bestPage.url,
										newWorkers: bestPage.workerCount,
									},
									"Switching to page with more workers",
								);

								// Stop monitoring old page
								this.consoleMonitor.stopMonitoring();

								// Start monitoring new page
								await this.consoleMonitor.startMonitoring(bestPage.page);

								// Don't clear logs - preserve history across page switches
								logger.info("Console monitoring restarted on new page");
							}
						} catch (error) {
							logger.error(
								{ error },
								"Failed to check for better pages with workers",
							);
							// Don't throw - this is a best-effort optimization
						}
					}
				}

				// If connection was lost and browser is now connected, FORCE restart monitoring
				// Note: Can't use isConnectionAlive() here because page might not be fetched yet after reconnection
				// Instead, check if browser is connected using isRunning()
				if (!wasAlive && this.browserManager.isRunning()) {
					logger.info(
						"Connection was lost and recovered - forcing monitoring restart with fresh page",
					);
					this.consoleMonitor.stopMonitoring(); // Clear stale state
					const page = await this.browserManager.getPage();
					await this.consoleMonitor.startMonitoring(page);
				} else if (
					this.browserManager.isRunning() &&
					!this.consoleMonitor.getStatus().isMonitoring
				) {
					// Connection is fine but monitoring stopped for some reason
					logger.info(
						"Connection alive but monitoring stopped - restarting console monitoring",
					);
					const page = await this.browserManager.getPage();
					await this.consoleMonitor.startMonitoring(page);
				}
			}

			if (!this.consoleMonitor) {
				logger.info("Initializing ConsoleMonitor");
				this.consoleMonitor = new ConsoleMonitor(this.config.console);

				// Connect to browser and begin monitoring
				logger.info("Getting browser page");
				const page = await this.browserManager.getPage();

				logger.info("Starting console monitoring");
				await this.consoleMonitor.startMonitoring(page);

				logger.info("Browser and console monitor initialized successfully");
			}
		} catch (error) {
			logger.error({ error }, "Failed to initialize browser/monitor");
			throw new Error(
				`Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Register all MCP tools
	 */
	private registerTools(): void {
		const deps: LocalToolDeps = {
			server: this.server,
			getFigmaAPI: () => this.getFigmaAPI(),
			getCurrentUrl: () => this.getCurrentFileUrl(),
			getDesktopConnector: () => this.getDesktopConnector(),
			ensureInitialized: () => this.ensureInitialized(),
			getBrowserManager: () => this.browserManager,
			getConsoleMonitor: () => this.consoleMonitor,
			getWsServer: () => this.wsServer,
			config: this.config,
			variablesCache: this.variablesCache,
			sessionCache: this.sessionCache,
			projectContextCache: this.projectContextCache,
			teamLibraryCache: this.teamLibraryCache,
			designSystems: this.designSystems,
			getDesktopConnectorRaw: () => this.desktopConnector,
			setDesktopConnector: (c) => { this.desktopConnector = c; },
			getWsActualPort: () => this.wsActualPort,
			getWsPreferredPort: () => this.wsPreferredPort,
			getWsStartupError: () => this.wsStartupError,
			getPluginPath: () => this.getPluginPath(),
		};

		// Local-only tools (4 domain modules)
		registerConnectionTools(deps);
		registerVariableTools(deps);
		registerComponentTools(deps);
		registerNodeTools(deps);

		// Register Figma API tools (Tools 8-11)
		registerFigmaAPITools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
			() => this.consoleMonitor || null,
			() => this.browserManager || null,
			() => this.ensureInitialized(),
			this.variablesCache, // Pass cache for efficient variable queries
			() => this.getDesktopConnector(), // Transport-aware connector factory
		);

		// Register Batch tool
		registerBatchTool(this.server);

		// Register context resources (Layer 2 — figma://context/* MCP resources)
		registerContextResources(
			this.server,
			this.projectContextCache,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
			{
				teamLibraryCache: this.teamLibraryCache,
				designSystems: this.designSystems,
			},
		);

		// MCP Apps - gated behind ENABLE_MCP_APPS env var
		if (process.env.ENABLE_MCP_APPS === "true") {
			registerTokenBrowserApp(this.server, async (fileUrl?: string) => {
				const url = fileUrl || this.getCurrentFileUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL available. Either pass a fileUrl, call figma_connection action='navigate' (CDP mode), or ensure the Desktop Bridge plugin is connected (WebSocket mode).",
					);
				}

				const urlInfo = extractFigmaUrlInfo(url);
				if (!urlInfo) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				const fileKey = urlInfo.branchId || urlInfo.fileKey;

				// Fetch file info for display (non-blocking, best-effort)
				let fileInfo: { name: string } | undefined;
				try {
					const api = await this.getFigmaAPI();
					const fileData = await api.getFile(fileKey, { depth: 0 });
					if (fileData?.name) {
						fileInfo = { name: fileData.name };
					}
				} catch {
					// Fall back to extracting name from URL
					try {
						const urlObj = new URL(url);
						const segments = urlObj.pathname.split("/").filter(Boolean);
						const branchIdx = segments.indexOf("branch");
						const nameSegment =
							branchIdx >= 0
								? segments[branchIdx + 2]
								: segments.length >= 3
									? segments[2]
									: undefined;
						if (nameSegment) {
							fileInfo = {
								name: decodeURIComponent(nameSegment).replace(/-/g, " "),
							};
						}
					} catch {
						// Leave fileInfo undefined
					}
				}

				// Check cache first (works for both Desktop Bridge and REST API data)
				const cacheEntry = this.variablesCache.get(fileKey);
				if (cacheEntry && Date.now() - cacheEntry.timestamp < 5 * 60 * 1000) {
					const cached = cacheEntry.data;
					// Desktop Bridge caches arrays directly; REST API data needs formatVariables
					if (Array.isArray(cached.variables)) {
						return {
							variables: cached.variables,
							collections: cached.variableCollections || [],
							fileInfo,
						};
					}
					const formatted = formatVariables(cached);
					return {
						variables: formatted.variables,
						collections: formatted.collections,
						fileInfo,
					};
				}

				// Priority 1: Try Desktop Bridge via transport-agnostic connector (WebSocket or CDP)
				try {
					const connector = await this.getDesktopConnector();
					const desktopResult =
						await connector.getVariablesFromPluginUI(fileKey);

					if (desktopResult.success && desktopResult.variables) {
						// Cache the desktop result
						this.variablesCache.set(fileKey, {
							data: {
								variables: desktopResult.variables,
								variableCollections: desktopResult.variableCollections,
							},
							timestamp: Date.now(),
						});

						return {
							variables: desktopResult.variables,
							collections: desktopResult.variableCollections || [],
							fileInfo,
						};
					}
				} catch (desktopErr) {
					logger.warn(
						{
							error:
								desktopErr instanceof Error
									? desktopErr.message
									: String(desktopErr),
						},
						"Desktop Bridge failed for token browser, trying REST API",
					);
				}

				// Priority 2: Fall back to REST API
				const api = await this.getFigmaAPI();
				const { local, localError } = await api.getAllVariables(fileKey);

				if (localError) {
					throw new Error(
						`Could not fetch variables. Desktop Bridge unavailable and REST API returned: ${localError}`,
					);
				}

				// Cache raw REST API data
				this.variablesCache.set(fileKey, {
					data: local,
					timestamp: Date.now(),
				});

				const formatted = formatVariables(local);
				return {
					variables: formatted.variables,
					collections: formatted.collections,
					fileInfo,
				};
			});

			registerDesignSystemDashboardApp(
				this.server,
				async (fileUrl?: string) => {
					const url = fileUrl || this.getCurrentFileUrl();
					if (!url) {
						throw new Error(
							"No Figma file URL available. Either pass a fileUrl, call figma_connection action='navigate' (CDP mode), or ensure the Desktop Bridge plugin is connected (WebSocket mode).",
						);
					}

					const urlInfo = extractFigmaUrlInfo(url);
					if (!urlInfo) {
						throw new Error(`Invalid Figma URL: ${url}`);
					}

					const fileKey = urlInfo.branchId || urlInfo.fileKey;

					// Track data availability for transparent scoring
					let variablesAvailable = false;
					let variableError: string | undefined;
					let desktopBridgeAttempted = false;
					let desktopBridgeFailed = false;
					let restApiAttempted = false;
					let restApiFailed = false;

					// Fetch variables + collections
					// Fallback chain: Cache → Desktop Bridge → REST API → Actionable error
					let variables: any[] = [];
					let collections: any[] = [];

					// 1. Check cache first
					const cacheEntry = this.variablesCache.get(fileKey);
					if (cacheEntry && Date.now() - cacheEntry.timestamp < 5 * 60 * 1000) {
						const cached = cacheEntry.data;
						if (Array.isArray(cached.variables)) {
							variables = cached.variables;
							collections = cached.variableCollections || [];
						} else {
							const formatted = formatVariables(cached);
							variables = formatted.variables;
							collections = formatted.collections;
						}
						variablesAvailable = variables.length > 0;
					}

					// 2. Try Desktop Bridge via transport-agnostic connector (WebSocket or CDP)
					if (variables.length === 0) {
						desktopBridgeAttempted = true;
						try {
							const connector = await this.getDesktopConnector();
							const desktopResult =
								await connector.getVariablesFromPluginUI(fileKey);

							if (desktopResult.success && desktopResult.variables) {
								this.variablesCache.set(fileKey, {
									data: {
										variables: desktopResult.variables,
										variableCollections: desktopResult.variableCollections,
									},
									timestamp: Date.now(),
								});
								variables = desktopResult.variables;
								collections = desktopResult.variableCollections || [];
								variablesAvailable = true;
							} else {
								desktopBridgeFailed = true;
							}
						} catch (desktopErr) {
							desktopBridgeFailed = true;
							logger.warn(
								{
									error:
										desktopErr instanceof Error
											? desktopErr.message
											: String(desktopErr),
								},
								"Desktop Bridge failed for dashboard, trying REST API for variables",
							);
						}
					}

					// 3. Try REST API as fallback
					if (variables.length === 0) {
						restApiAttempted = true;
						try {
							const api = await this.getFigmaAPI();
							const { local, localError } = await api.getAllVariables(fileKey);
							if (!localError && local) {
								this.variablesCache.set(fileKey, {
									data: local,
									timestamp: Date.now(),
								});
								const formatted = formatVariables(local);
								variables = formatted.variables;
								collections = formatted.collections;
								variablesAvailable = true;
							} else {
								restApiFailed = true;
							}
						} catch (varErr) {
							restApiFailed = true;
							logger.warn(
								{
									error:
										varErr instanceof Error ? varErr.message : String(varErr),
								},
								"REST API variable fetch failed for dashboard",
							);
						}
					}

					// 4. Build actionable error message based on what was tried
					if (!variablesAvailable) {
						if (desktopBridgeFailed && restApiFailed) {
							variableError =
								"Desktop Bridge plugin not connected and REST API unavailable. Please open the Desktop Bridge plugin in Figma to enable variable/token analysis.";
						} else if (desktopBridgeFailed) {
							variableError =
								"Desktop Bridge plugin not connected. Please open the Desktop Bridge plugin in Figma to enable variable/token analysis.";
						} else if (restApiFailed) {
							variableError =
								"REST API unavailable. Connect the Desktop Bridge plugin in Figma for variable/token access.";
						} else if (!desktopBridgeAttempted && !restApiAttempted) {
							variableError =
								"No variable fetch methods available. Connect the Desktop Bridge plugin in Figma.";
						}
					}

					// Fetch file metadata, components, component sets, and styles via REST API
					let fileInfo:
						| {
								name: string;
								lastModified: string;
								version?: string;
								thumbnailUrl?: string;
						  }
						| undefined;
					let components: any[] = [];
					let componentSets: any[] = [];
					let styles: any[] = [];

					try {
						const api = await this.getFigmaAPI();
						const [fileData, compResult, compSetResult, styleResult] =
							await Promise.all([
								api.getFile(fileKey, { depth: 0 }).catch(() => null),
								api
									.getComponents(fileKey)
									.catch(() => ({ meta: { components: [] } })),
								api
									.getComponentSets(fileKey)
									.catch(() => ({ meta: { component_sets: [] } })),
								api.getStyles(fileKey).catch(() => ({ meta: { styles: [] } })),
							]);
						if (fileData) {
							fileInfo = {
								name: fileData.name || "Unknown",
								lastModified: fileData.lastModified || "",
								version: fileData.version,
								thumbnailUrl: fileData.thumbnailUrl,
							};
						}
						components = compResult?.meta?.components || [];
						componentSets = compSetResult?.meta?.component_sets || [];
						styles = styleResult?.meta?.styles || [];
					} catch (apiErr) {
						logger.warn(
							{
								error:
									apiErr instanceof Error ? apiErr.message : String(apiErr),
							},
							"REST API fetch failed for dashboard",
						);
					}

					// Fallback: extract file name from URL if getFile failed
					if (!fileInfo) {
						try {
							const urlObj = new URL(url);
							const segments = urlObj.pathname.split("/").filter(Boolean);
							// /design/KEY/File-Name or /design/KEY/branch/BRANCHKEY/File-Name
							const branchIdx = segments.indexOf("branch");
							const nameSegment =
								branchIdx >= 0
									? segments[branchIdx + 2]
									: segments.length >= 3
										? segments[2]
										: undefined;
							if (nameSegment) {
								fileInfo = {
									name: decodeURIComponent(nameSegment).replace(/-/g, " "),
									lastModified: "",
								};
							}
						} catch {
							// URL parsing failed — leave fileInfo undefined
						}
					}

					return {
						variables,
						collections,
						components,
						styles,
						componentSets,
						fileInfo,
						dataAvailability: {
							variables: variablesAvailable,
							collections: variablesAvailable,
							components: components.length > 0,
							styles: styles.length > 0,
							variableError,
						},
					};
				},
				// Pass getCurrentUrl so dashboard can track which file was audited
				() => this.getCurrentFileUrl(),
			);

			logger.info("MCP Apps registered (ENABLE_MCP_APPS=true)");
		}

		logger.info(
			"All MCP tools registered successfully (including write operations)",
		);
	}

	/**
	 * Start the MCP server
	 */
	async start(): Promise<void> {
		try {
			logger.info(
				{ config: this.config },
				"Starting Figma Console MCP (Local Mode)",
			);

			// Parse design systems config: FIGMA_DESIGN_SYSTEMS (JSON) or FIGMA_TEAM_ID (legacy)
			const dsEnv = process.env.FIGMA_DESIGN_SYSTEMS?.trim();
			if (dsEnv) {
				try {
					const parsed = JSON.parse(dsEnv);
					for (const [name, id] of Object.entries(parsed)) {
						this.designSystems.set(name, String(id));
					}
					logger.info({ designSystems: Object.fromEntries(this.designSystems) }, 'Design systems configured');
				} catch (e) {
					logger.error({ raw: dsEnv }, 'Failed to parse FIGMA_DESIGN_SYSTEMS — must be valid JSON like {"my-ds": "12345"}');
				}
			} else {
				// Legacy fallback: FIGMA_TEAM_ID (comma-separated)
				const teamIdEnv = process.env.FIGMA_TEAM_ID?.trim();
				if (teamIdEnv) {
					const ids = teamIdEnv.split(',').map(id => id.trim()).filter(Boolean);
					ids.forEach((id, i) => this.designSystems.set(ids.length === 1 ? 'default' : `team-${i + 1}`, id));
					logger.info({ designSystems: Object.fromEntries(this.designSystems) }, 'Design systems configured (from FIGMA_TEAM_ID)');
				}
			}

			// Start WebSocket bridge server with port range fallback.
			// If the preferred port is taken (e.g., Claude Desktop Chat tab already bound it),
			// try subsequent ports in the range (9223-9232) so multiple instances can coexist.
			const wsHost = process.env.FIGMA_WS_HOST || 'localhost';
			this.wsPreferredPort = parseInt(process.env.FIGMA_WS_PORT || String(DEFAULT_WS_PORT), 10);

			// Clean up any stale port files from crashed instances before trying to bind
			cleanupStalePortFiles();

			const portsToTry = getPortRange(this.wsPreferredPort);
			let boundPort: number | null = null;

			for (const port of portsToTry) {
				try {
					this.wsServer = new FigmaWebSocketServer({ port, host: wsHost });
					await this.wsServer.start();

					// Get the actual bound port (should match, but verify)
					const addr = this.wsServer.address();
					boundPort = addr?.port ?? port;
					this.wsActualPort = boundPort;

					if (boundPort !== this.wsPreferredPort) {
						logger.info(
							{ preferredPort: this.wsPreferredPort, actualPort: boundPort },
							"Preferred WebSocket port was in use, bound to fallback port",
						);
					} else {
						logger.info({ wsPort: boundPort }, "WebSocket bridge server started");
					}

					// Advertise the port so the Figma plugin and other tools can discover us
					advertisePort(boundPort, wsHost);
					registerPortCleanup(boundPort);

					break;
				} catch (wsError) {
					const errorMsg = wsError instanceof Error ? wsError.message : String(wsError);
					const errorCode = wsError instanceof Error ? (wsError as any).code : undefined;

					if (errorCode === "EADDRINUSE" || errorMsg.includes("EADDRINUSE")) {
						logger.debug(
							{ port, error: errorMsg },
							"Port in use, trying next in range",
						);
						this.wsServer = null;
						continue;
					}

					// Non-port-conflict error — don't try more ports
					logger.warn(
						{ error: errorMsg, port },
						"Failed to start WebSocket bridge server",
					);
					this.wsServer = null;
					break;
				}
			}

			if (!boundPort) {
				this.wsStartupError = {
					code: "EADDRINUSE",
					port: this.wsPreferredPort,
				};
				const rangeEnd = this.wsPreferredPort + portsToTry.length - 1;
				logger.warn(
					{ portRange: `${this.wsPreferredPort}-${rangeEnd}` },
					"All WebSocket ports in range are in use — running without WebSocket transport",
				);
			}

			if (this.wsServer) {
				// Log when plugin files connect/disconnect (with file identity)
				this.wsServer.on("fileConnected", (data: { fileKey: string; fileName: string }) => {
					logger.info({ fileKey: data.fileKey, fileName: data.fileName }, "Desktop Bridge plugin connected via WebSocket");
					// Warm the project context cache for the connected file
					this.getFigmaAPI()
						.then((api) => this.projectContextCache.build(data.fileKey, api))
						.catch((err) => {
							logger.debug({ fileKey: data.fileKey, error: err instanceof Error ? err.message : String(err) }, "Failed to warm project context cache");
						});
				});
				this.wsServer.on("fileDisconnected", (data: { fileKey: string; fileName: string }) => {
					logger.info({ fileKey: data.fileKey, fileName: data.fileName }, "Desktop Bridge plugin disconnected from WebSocket");
				});

				// Invalidate variable cache when document changes are reported.
				// Figma's documentchange API doesn't expose a specific variable change type —
				// variable operations manifest as node PROPERTY_CHANGE events, so we invalidate
				// on any style or node change to be safe.
				// Per-file debounce: skip invalidation if we already invalidated this fileKey
				// within the last 1 second. The client-side debounce (ui.html) is the primary
				// control; this is a safety net for burst events.
				const lastInvalidationTime = new Map<string, number>();
				const INVALIDATION_DEBOUNCE_MS = 1000;

				this.wsServer.on("documentChange", (data: any) => {
					if (data.hasStyleChanges || data.hasNodeChanges) {
						if (data.fileKey) {
							const now = Date.now();
							const lastTime = lastInvalidationTime.get(data.fileKey) || 0;
							if (now - lastTime < INVALIDATION_DEBOUNCE_MS) {
								return; // Skip — already invalidated recently
							}
							lastInvalidationTime.set(data.fileKey, now);

							// Per-file cache invalidation — only clear the affected file's cache
							this.variablesCache.delete(data.fileKey);
							this.sessionCache.invalidateFile(data.fileKey);
							this.projectContextCache.invalidate(data.fileKey).catch(() => {});
						} else {
							// No fileKey — clear everything
							this.variablesCache.clear();
							this.sessionCache.clear();
							this.projectContextCache.invalidateAll().catch(() => {});
						}
						logger.info(
							{ fileKey: data.fileKey, changeCount: data.changeCount, hasStyleChanges: data.hasStyleChanges, hasNodeChanges: data.hasNodeChanges },
							"Caches invalidated due to document changes"
						);
					}
				});
			}

			// Check if Figma Desktop is accessible (non-blocking, just for logging)
			logger.info("Checking Figma Desktop accessibility...");
			await this.checkFigmaDesktop();

			// Register all tools
			this.registerTools();

			// Create stdio transport
			const transport = new StdioServerTransport();

			// Connect server to transport
			await this.server.connect(transport);

			logger.info("MCP server started successfully on stdio transport");

			// Warm team library caches in background (non-blocking)
			if (this.designSystems.size > 0) {
				this.getFigmaAPI()
					.then((api) => {
						for (const teamId of this.designSystems.values()) {
							this.teamLibraryCache.build(teamId, api).catch((err) => {
								logger.debug({ teamId, error: err instanceof Error ? err.message : String(err) }, 'Failed to warm team library cache');
							});
						}
					})
					.catch((err) => {
						logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Failed to get API for team library warming');
					});
			}

			// 🆕 AUTO-CONNECT: Start monitoring immediately if Figma Desktop is available
			// This enables "get latest logs" workflow without requiring manual setup
			this.autoConnectToFigma();
		} catch (error) {
			logger.error({ error }, "Failed to start MCP server");

			// Log helpful error message to stderr
			console.error("\n❌ Failed to start Figma Console MCP:\n");
			console.error(error instanceof Error ? error.message : String(error));
			console.error("\n");

			process.exit(1);
		}
	}

	/**
	 * Cleanup and shutdown
	 */
	async shutdown(): Promise<void> {
		logger.info("Shutting down MCP server...");

		try {
			// Clean up port advertisement before stopping the server
			if (this.wsActualPort) {
				unadvertisePort(this.wsActualPort);
			}

			if (this.wsServer) {
				await this.wsServer.stop();
			}

			if (this.consoleMonitor) {
				await this.consoleMonitor.stopMonitoring();
			}

			if (this.browserManager) {
				await this.browserManager.close();
			}

			logger.info("MCP server shutdown complete");
		} catch (error) {
			logger.error({ error }, "Error during shutdown");
		}
	}
}

/**
 * Main entry point
 */
async function main() {
	const server = new LocalFigmaConsoleMCP();

	// Handle graceful shutdown
	process.on("SIGINT", async () => {
		await server.shutdown();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		await server.shutdown();
		process.exit(0);
	});

	// Start the server
	await server.start();
}

// Run if executed directly
// Note: On Windows, import.meta.url uses file:/// (3 slashes) while process.argv uses backslashes
// We normalize both paths to compare correctly across platforms
// realpathSync resolves symlinks (e.g. node_modules/.bin/figma-console-mcp -> dist/local.js)
// which is required for npx to work, since npx runs the binary via a symlink
const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";

if (currentFile === entryFile) {
	main().catch((error) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}

export { LocalFigmaConsoleMCP };
