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
				instructions: `## Figma Console MCP — Tool Reference (25 tools)

### Session Start
1. figma_connection action='navigate' — open a Figma URL or switch files. ALWAYS first.
2. figma_find_components verbosity='overview' — get design system map (components, tokens, categories).
3. figma_get_selection — see what the user has selected (WebSocket only). Use instead of asking.

### Read Data (start with lowest verbosity, escalate on demand)
- figma_get_file_data — document tree. Start verbosity='summary' depth=1, then drill into nodeIds.
- figma_get_variables — design tokens/variables. Start format='summary'. Works via Desktop Bridge on all plans.
- figma_get_styles — color, text, effect, grid styles with optional code exports.
- figma_get_component — single component detail (metadata | reconstruction | development format).
- figma_find_components — search/browse components. Levels: overview → keys → summary → details.
- figma_get_library_components — search team's published library by name (needs FIGMA_DESIGN_SYSTEMS).

### Write: Node Structure
- figma_edit_node — action: resize | move | clone | delete | rename | reparent | reorder.
- figma_create_nodes — create a node or entire node tree inside a parent. Supports COMPONENT type for reusable definitions.
- figma_manage_page — action: create | delete | rename | switch | reorder | list.

### Write: Visual Properties
- figma_set_appearance — fills, strokes, opacity, cornerRadius, effects, rotation, blendMode.
- figma_set_text — content + full typography (font, size, alignment, spacing, decoration, case).
- figma_set_layout — auto-layout (flexbox) or CSS grid on frames. Padding, gap, alignment, wrap.

### Write: Components & Instances
- figma_instantiate_component — create instance. ALWAYS pass both componentKey AND nodeId together.
- figma_set_instance_properties — update props on instance. NOT direct text editing (fails silently).
- figma_component_property — action: add | edit | delete | set_description. Manage component props and descriptions.
- figma_arrange_component_set — organize variant grid with Figma's native layout.

### Write: Variables & Tokens
- figma_variable_operation — single mutation. action: update_value | create | create_collection | delete | rename | add_mode | rename_mode.
- figma_batch_variables — bulk ops, 10-50x faster. action: create (add to collection) | update (change values) | setup (create collection + modes + all variables atomically).

### Write: Styles & Prototyping
- figma_create_style — action: create | update | delete | list. Paint, text, effect styles.
- figma_set_reaction — action: add | remove | list. Prototyping triggers, actions, transitions.

### Observe & Debug
- figma_screenshot — capture live state (source='plugin') or REST render (source='api'). Returns base64, call standalone — never inside figma_batch.
- figma_console — action: get (past logs) | watch (real-time stream) | clear.
### Connection & Environment
- figma_connection — action: navigate | status | reconnect | invalidate_cache | reload | list_files | changes.

### Multi-Tool
- figma_batch — run up to 25 tools in one request. Do NOT include figma_screenshot (payload too large).

### Modifying Designs
- NEVER delete and rebuild when a modification was requested. Inspect existing nodes → use set_* tools.
- Before ANY edit: figma_get_selection or figma_edit_node action='inspect' to get current node IDs and state.
- To find existing nodes: figma_get_file_data with the parent nodeId, depth=2. Never guess IDs.
- To see recent changes (yours or user's): figma_connection action='changes'.
- Modify with figma_set_text, figma_set_appearance, figma_set_layout — not by recreating trees.
- Only use figma_create_nodes for NEW nodes that don't exist yet.
- After visual changes: screenshot once to verify. Max 2 fix iterations, then ask the user.

### Design Resources — Local vs Remote
- Local variables/tokens: figma_get_variables format='summary' — live from Desktop Bridge cache.
- Local styles: figma_get_styles — color, text, effect styles with resolved values.
- Local components: figma_find_components verbosity='keys' query='Name' — cached keys for instantiation.
- Remote/library components: figma_get_library_components namePattern='Name' — team library cache (60min TTL).
- Remote/library styles: figma_get_library_components type='style' namePattern='Name' — returns style keys.
- Style keys from the library work DIRECTLY as fillStyleId/textStyleId/effectStyleId — the plugin resolves keys internally. No need to convert keys to local IDs.
- DO NOT inspect random nodes to discover colors/fonts/tokens. The caches above have everything indexed.

### Figma Layout Rules (the API does NOT auto-fix layout)
- Children in auto-layout default to FIXED sizing. Set layoutSizingHorizontal/Vertical explicitly via figma_set_layout.
- TEXT in auto-layout: use layoutSizingHorizontal='FILL' to wrap text to parent width (textAutoResize is auto-applied).
- TEXT without auto-layout parent: set explicit width instead.
- GRID: children all stack at cell (0,0) by default. You MUST set gridColumnAnchorIndex + gridRowAnchorIndex on EACH child via figma_set_layout.
- Creating a frame does NOT make it auto-layout. Set layoutMode explicitly.
- Coordinates (x, y) are parent-relative. Section parents offset from page origin.

### Component Instances
- INSTANCE_SWAP overrides: figma_instantiate_component's overrides param ONLY handles TEXT and BOOLEAN properties. For INSTANCE_SWAP, you MUST call figma_set_instance_properties as a separate step after instantiation.
- For component instances, ONLY use figma_set_instance_properties for text/variant/boolean changes. Direct text/fill edits silently fail.
- When using figma_batch with component instantiation, compact mode now includes instance IDs. Use verbose=true only if you need the full instance object.

### Text Styles and Fills
- To apply a text style while preserving a custom fill: (1) figma_set_text with textStyleId, then (2) figma_set_appearance with fills. The style sets typography; the fill override sticks on top.
- When mixing text nodes in the same layout, ensure lineHeight values match. Mixing INTRINSIC (auto) with explicit percentages (e.g. 150%) causes baseline misalignment.
- To verify style bindings after applying: figma_get_file_data on the specific node with depth=0 — check the styles.text or styles.fill field. The figma_get_styles tool only lists file-level style definitions, not per-node bindings.

### Rules
- NodeIds are session-specific — NEVER reuse from a previous conversation. Always re-fetch.
- Start at lowest verbosity/depth — verbosity='summary', depth=1. Escalate only when proven insufficient.
- Place components inside a Section or Frame, never on bare canvas.
- Test tool capabilities on ONE node first before applying to many.
- figma_get_variables works via Desktop Bridge on all plans. REST API fallback available for Enterprise users.
- Always verify file name before destructive operations when multiple files are connected.`,
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
