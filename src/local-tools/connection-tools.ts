/**
 * Connection and observation tools — console, connection, selection.
 * These manage Figma connection state and observe the environment.
 */

import { z } from "zod";
import { extractFileKey } from "../core/figma-api.js";
import { createChildLogger } from "../core/logger.js";
import { discoverActiveInstances } from "../core/port-discovery.js";
import type { LocalToolDeps } from "./types.js";

const logger = createChildLogger({ component: "connection-tools" });

export function registerConnectionTools(deps: LocalToolDeps): void {
	const {
		server, getFigmaAPI, getCurrentUrl, getDesktopConnector, ensureInitialized,
		getBrowserManager, getConsoleMonitor, getWsServer, config,
		variablesCache, sessionCache, projectContextCache, teamLibraryCache, teamIds,
		getDesktopConnectorRaw, setDesktopConnector,
		getWsActualPort, getWsPreferredPort, getWsStartupError, getPluginPath,
	} = deps;

	// Consolidated console tool: get, watch, clear
	server.tool(
		"figma_console",
		`Interact with Figma's console output. Works with both CDP and WebSocket transports.

Actions:
- get: Retrieve recent console logs. Works immediately for plugin developers — no navigation needed.
- watch: Stream logs in real-time for a duration (max 5 min). Use for monitoring plugin execution during manual testing.
- clear: Clear the console buffer. WebSocket mode is non-disruptive; CDP mode may require reconnect.`,
		{
			action: z
				.enum(["get", "watch", "clear"])
				.describe("'get' for past logs, 'watch' for real-time streaming, 'clear' to reset buffer"),
			count: z
				.number()
				.optional()
				.default(100)
				.describe("Number of logs to retrieve (get only)"),
			level: z
				.enum(["log", "info", "warn", "error", "debug", "all"])
				.optional()
				.default("all")
				.describe("Filter by log level (get/watch)"),
			since: z
				.number()
				.optional()
				.describe("Only logs after this Unix ms timestamp (get only)"),
			duration: z
				.number()
				.optional()
				.default(30)
				.describe("Watch duration in seconds (watch only, max 300)"),
		},
		{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		async ({ action, count, level, since, duration }) => {
			if (action === "clear") {
				try {
					let clearedCount = 0;
					let transport: "cdp" | "websocket" = "cdp";

					const wsServer = getWsServer();
					const consoleMonitor = getConsoleMonitor();

					if (wsServer?.isClientConnected()) {
						clearedCount = wsServer.clearConsoleLogs();
						transport = "websocket";
					} else {
						if (!consoleMonitor) {
							await ensureInitialized();
						}
						const cm = getConsoleMonitor();
						if (cm) {
							clearedCount = cm.clear();
						} else {
							throw new Error(
								"No console monitoring available. Open the Desktop Bridge plugin or enable CDP. [AI: No transport is connected. Ask the user to open the Desktop Bridge plugin, or relaunch Figma with --remote-debugging-port=9222.]",
							);
						}
					}

					const responseData: any = {
						status: "cleared",
						clearedCount,
						transport,
					};

					if (transport === "websocket") {
						responseData.ai_instruction =
							"Console buffer cleared via WebSocket. No reconnection needed — monitoring continues automatically.";
					} else {
						responseData.ai_instruction =
							"Console cleared via CDP. This may disrupt monitoring. Reconnect MCP if logs stop appearing.";
					}

					return {
						content: [{ type: "text", text: JSON.stringify(responseData) }],
					};
				} catch (error) {
					logger.error({ error }, "Failed to clear console");
					return {
						content: [{ type: "text", text: JSON.stringify({ error: String(error), message: "Failed to clear console buffer" }) }],
						isError: true,
					};
				}
			}

			if (action === "watch") {
				const consoleMonitor = getConsoleMonitor();
				const wsServer = getWsServer();
				const useCDP = consoleMonitor?.getStatus().isMonitoring;
				const useWS = !useCDP && wsServer?.isClientConnected();

				if (!useCDP && !useWS) {
					throw new Error(
						"No console monitoring available. Either enable CDP (--remote-debugging-port=9222) or open the Desktop Bridge plugin for WebSocket-based console capture. [AI: No transport is connected. Ask the user to open the Desktop Bridge plugin in Figma, or relaunch Figma with --remote-debugging-port=9222 for CDP.]",
					);
				}

				const startTime = Date.now();
				const startLogCount = useCDP
					? consoleMonitor!.getStatus().logCount
					: wsServer!.getConsoleStatus().logCount;

				await new Promise((resolve) => setTimeout(resolve, (duration ?? 30) * 1000));

				const watchedLogs = useCDP
					? consoleMonitor!.getLogs({
							level: level === "all" ? undefined : level,
							since: startTime,
						})
					: wsServer!.getConsoleLogs({
							level: level === "all" ? undefined : level,
							since: startTime,
						});

				const endLogCount = useCDP
					? consoleMonitor!.getStatus().logCount
					: wsServer!.getConsoleStatus().logCount;
				const newLogsCount = endLogCount - startLogCount;

				const responseData: any = {
					status: "completed",
					duration: `${duration ?? 30} seconds`,
					startTime: new Date(startTime).toISOString(),
					endTime: new Date(Date.now()).toISOString(),
					filter: level,
					transport: useCDP ? "cdp" : "websocket",
					statistics: {
						totalLogsInBuffer: endLogCount,
						logsAddedDuringWatch: newLogsCount,
						logsMatchingFilter: watchedLogs.length,
					},
					logs: watchedLogs,
				};

				if (useWS) {
					responseData.ai_instruction =
						"Console logs captured via WebSocket Bridge (plugin sandbox only). For full-page monitoring, use CDP mode.";
				}

				return {
					content: [{ type: "text", text: JSON.stringify(responseData) }],
				};
			}

			// action === "get"
			try {
				let logs: import("../core/types/index.js").ConsoleLogEntry[];
				let status: any;
				let source: "cdp" | "websocket" = "cdp";
				const consoleMonitor = getConsoleMonitor();
				const wsServer = getWsServer();

				if (consoleMonitor?.getStatus().isMonitoring) {
					logs = consoleMonitor.getLogs({ count, level, since });
					status = consoleMonitor.getStatus();
				} else if (wsServer?.isClientConnected()) {
					logs = wsServer.getConsoleLogs({ count, level, since });
					status = wsServer.getConsoleStatus();
					source = "websocket";
				} else {
					try {
						await ensureInitialized();
						const cm = getConsoleMonitor();
						if (cm) {
							logs = cm.getLogs({ count, level, since });
							status = cm.getStatus();
						} else {
							throw new Error("Console monitor not initialized");
						}
					} catch {
						throw new Error(
							"No console monitoring available. Either enable CDP (--remote-debugging-port=9222) or open the Desktop Bridge plugin for WebSocket-based console capture. [AI: No transport is connected. Ask the user to open the Desktop Bridge plugin in Figma, or relaunch Figma with --remote-debugging-port=9222 for CDP.]",
						);
					}
				}

				const responseData: any = {
					logs,
					totalCount: logs.length,
					oldestTimestamp: logs[0]?.timestamp,
					newestTimestamp: logs[logs.length - 1]?.timestamp,
					status,
					transport: source,
				};

				if (source === "websocket") {
					responseData.ai_instruction =
						"Console logs captured via WebSocket Bridge (plugin sandbox only). For full-page console monitoring, use CDP mode (--remote-debugging-port=9222).";
				}

				if (logs.length === 0) {
					if (source === "websocket") {
						responseData.ai_instruction =
							"No console logs captured yet via WebSocket. Try running a design operation that triggers plugin logging.";
					} else {
						const isMonitoring = (status as any).isMonitoring;
						if (!isMonitoring) {
							responseData.ai_instruction =
								"Console monitoring is not active. Call figma_connection with action='status' to check, then figma_connection action='navigate' to reconnect.";
						} else {
							responseData.ai_instruction =
								"No console logs found. Try running your Figma plugin, then check logs again.";
						}
					}
				}

				return {
					content: [{ type: "text", text: JSON.stringify(responseData) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get console logs");
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: JSON.stringify({ error: errorMessage, message: "Failed to retrieve console logs." }) }],
					isError: true,
				};
			}
		},
	);

	// Tool: Consolidated connection management (includes navigation)
	server.tool(
		"figma_connection",
		`Manage the Figma connection, navigate to files, and control the environment. Actions:
- navigate: Open a Figma URL or switch to a connected file. ALWAYS use this first when starting a session or switching files. Initializes browser connection and console monitoring.
- status: Check transport health, active file, and connection details.
- reconnect: Force reconnection to Figma Desktop (CDP or WebSocket). Clears stale connector cache.
- invalidate_cache: Force-rebuild all cache layers for a file (disk, session, variables). Use when cached context is stale.
- reload: Reload the Figma page/plugin to test code changes. For plugin development iteration.
- list_files: List all Figma files connected via Desktop Bridge (WebSocket multi-client).
- changes: Get recent document changes detected via Desktop Bridge. Returns buffered change events.`,
		{
			action: z.enum(["navigate", "status", "reconnect", "invalidate_cache", "reload", "list_files", "changes"]),
			url: z.string().optional().describe("Figma URL to navigate to (required for navigate action)"),
			fileUrl: z.string().optional().describe("Figma file URL (for invalidate_cache). Uses current file if omitted."),
			clearConsole: z.boolean().optional().default(true).describe("Clear console before reload (for reload action)"),
			since: z.number().optional().describe("Only changes after this Unix timestamp ms (for changes action)"),
			count: z.number().optional().describe("Max change events to return (for changes action)"),
			clear: z.boolean().optional().default(false).describe("Clear change buffer after reading (for changes action)"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async ({ action, url, fileUrl, clearConsole, since, count, clear }) => {
			if (action === "navigate") {
			// Navigate to a Figma URL or switch connected file
			if (!url) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: "url is required for navigate action" }) }],
					isError: true,
				};
			}
			try {
				const wsServer = getWsServer();
				// Try CDP first (full browser navigation)
				try {
					await ensureInitialized();
				} catch {
					// CDP not available — check if WebSocket is connected
					if (wsServer?.isClientConnected()) {
						const fileInfo = wsServer.getConnectedFileInfo();
						const requestedFileKey = extractFileKey(url);
						const isSameFile = !!(requestedFileKey && fileInfo?.fileKey && requestedFileKey === fileInfo.fileKey);

						if (isSameFile) {
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify(
											{
												status: "already_connected",
												connectedFile: {
													fileName: fileInfo!.fileName,
													fileKey: fileInfo!.fileKey,
												},
												message:
													"Already connected to this file via WebSocket. All tools are ready to use — no navigation needed.",
												ai_instruction:
													"The requested file is already connected via WebSocket. You can proceed with any tool calls (figma_get_variables, figma_get_file_data, etc.) without further navigation.",
											},
										),
									},
								],
							};
						}

						// Check if the requested file is connected via multi-client WebSocket
						if (requestedFileKey) {
							const connectedFiles = wsServer.getConnectedFiles();
							const targetFile = connectedFiles.find(f => f.fileKey === requestedFileKey);
							if (targetFile) {
								wsServer.setActiveFile(requestedFileKey);
								return {
									content: [
										{
											type: "text" as const,
											text: JSON.stringify(
												{
													status: "switched_active_file",
													activeFile: {
														fileName: targetFile.fileName,
														fileKey: targetFile.fileKey,
													},
													connectedFiles: connectedFiles.map(f => ({
														fileName: f.fileName,
														fileKey: f.fileKey,
														isActive: f.fileKey === requestedFileKey,
													})),
													message: `Switched active file to "${targetFile.fileName}". All tools now target this file.`,
													ai_instruction:
														"Active file has been switched via WebSocket. All subsequent tool calls (figma_get_variables, etc.) will target this file. No browser navigation needed.",
												},
											),
										},
									],
								};
							}
						}

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											status: "websocket_file_not_connected",
											connectedFile: fileInfo
												? {
														fileName: fileInfo.fileName,
														fileKey: fileInfo.fileKey,
													}
												: undefined,
											connectedFiles: wsServer.getConnectedFiles().map(f => ({
												fileName: f.fileName,
												fileKey: f.fileKey,
												isActive: f.isActive,
											})),
											requestedFileKey,
											message:
												"The requested file is not connected via WebSocket. Open the Desktop Bridge plugin in the target file — it will auto-connect. Use figma_connection with action 'list_files' to see all connected files.",
											ai_instruction:
												"The requested file is not in the connected files list. The user needs to open the Desktop Bridge plugin in the target Figma file. Once opened, it will auto-connect and appear in figma_connection action 'list_files'. Then use figma_connection action 'navigate' to switch to it.",
										},
									),
								},
							],
						};
					}
					throw new Error(
						"No connection available. Open the Desktop Bridge plugin in Figma or enable CDP (--remote-debugging-port=9222).",
					);
				}

				const browserManager = getBrowserManager();
				if (!browserManager) {
					throw new Error("Browser manager not initialized");
				}

				// Navigate to the URL (may switch to existing tab)
				const navResult = await browserManager.navigateToFigma(url);

				if (navResult.action === 'switched_to_existing') {
					const consoleMonitor = getConsoleMonitor();
					if (consoleMonitor) {
						consoleMonitor.stopMonitoring();
						await consoleMonitor.startMonitoring(navResult.page);
					}

					const desktopConnector = getDesktopConnectorRaw();
					if (desktopConnector) {
						desktopConnector.clearFrameCache();
					}

					const currentUrl = browserManager.getCurrentUrl();

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										status: "switched_to_existing",
										url: currentUrl,
										message:
											"Switched to existing tab for this Figma file. Console monitoring is active.",
									},
								),
							},
						],
					};
				}

				// Normal navigation
				const desktopConnector = getDesktopConnectorRaw();
				if (desktopConnector) {
					desktopConnector.clearFrameCache();
				}

				await new Promise((resolve) => setTimeout(resolve, 2000));

				const currentNavUrl = browserManager.getCurrentUrl();

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									status: "navigated",
									url: currentNavUrl,
									message:
										"Browser navigated to Figma. Console monitoring is active.",
								},
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to navigate to Figma");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to navigate to Figma URL",
									troubleshooting: [
										"In WebSocket mode: navigate manually in Figma and ensure Desktop Bridge plugin is open",
										"For automatic navigation: relaunch Figma with --remote-debugging-port=9222",
									],
								},
							),
						},
					],
					isError: true,
				};
			}
			}
			switch (action) {
			case "status": {
			try {
				const wsServer = getWsServer();
				const wsActualPort = getWsActualPort();
				const wsPreferredPort = getWsPreferredPort();
				const wsStartupError = getWsStartupError();
				const pluginPath = getPluginPath();

				// Check CDP availability (non-blocking)
				let cdpAvailable = false;
				let debugPortAccessible = false;
				try {
					const debugHost = config?.local?.debugHost ?? "localhost";
					const debugPort = config?.local?.debugPort ?? 9222;
					const response = await fetch(`http://${debugHost}:${debugPort}/json/version`, {
						signal: AbortSignal.timeout(2000),
					});
					debugPortAccessible = response.ok;
					cdpAvailable = debugPortAccessible;
				} catch (e) {
					// CDP not available
				}

				// Check WebSocket availability
				const wsConnected = wsServer?.isClientConnected() ?? false;

				// Try CDP initialization if available (but don't fail on error)
				let browserManager = getBrowserManager();
				let browserRunning = browserManager?.isRunning() ?? false;
				let monitorStatus = getConsoleMonitor()?.getStatus() ?? null;
				let currentUrl = getCurrentUrl();
				if (cdpAvailable && !browserRunning) {
					try {
						await ensureInitialized();
						browserManager = getBrowserManager();
						browserRunning = browserManager?.isRunning() ?? false;
						monitorStatus = getConsoleMonitor()?.getStatus() ?? null;
						currentUrl = getCurrentUrl();
					} catch {
						// CDP init failed - continue with WebSocket status
					}
				}

				// Determine active transport (matches getDesktopConnector priority: WS first)
				let activeTransport: string = "none";
				if (wsConnected) {
					activeTransport = "websocket";
				} else if (cdpAvailable && browserRunning) {
					activeTransport = "cdp";
				}

				// List available Figma pages (CDP only)
				let availablePages: Array<{
					url: string;
					workerCount: number;
					isCurrentPage: boolean;
				}> = [];
				if (browserManager && browserRunning) {
					try {
						const browser = (browserManager as any).browser;
						if (browser) {
							const pages = await browser.pages();
							availablePages = pages
								.filter((p: any) => {
									const url = p.url();
									return (
										url.includes("figma.com") && !url.includes("devtools")
									);
								})
								.map((p: any) => ({
									url: p.url(),
									workerCount: p.workers().length,
									isCurrentPage: p.url() === currentUrl,
								}));
						}
					} catch (e) {
						logger.error({ error: e }, "Failed to list available pages");
					}
				}

				// Get current file name — prefer cached info from WebSocket (instant, no roundtrip)
				let currentFileName: string | null = null;
				let currentFileKey: string | null = null;
				const wsFileInfo = wsServer?.getConnectedFileInfo() ?? null;
				if (wsFileInfo) {
					currentFileName = wsFileInfo.fileName;
					currentFileKey = wsFileInfo.fileKey;
				} else if (activeTransport !== "none") {
					// Fallback: ask the plugin directly (requires roundtrip)
					try {
						const connector = await getDesktopConnector();
						const fileInfo = await connector.executeCodeViaUI(
							"return { fileName: figma.root.name, fileKey: figma.fileKey }",
							5000,
						);
						if (fileInfo.success && fileInfo.result) {
							currentFileName = fileInfo.result.fileName;
							currentFileKey = fileInfo.result.fileKey;
						}
					} catch {
						// Non-critical - Desktop Bridge might not be running yet
					}
				}

				const setupValid = activeTransport !== "none";

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									mode: "local",
									currentFileName:
										currentFileName ||
										"(unable to retrieve - Desktop Bridge may need to be opened)",
									currentFileKey: currentFileKey || undefined,
									monitoredPageUrl: currentUrl,
									monitorWorkerCount: monitorStatus?.workerCount ?? 0,
									transport: {
										active: activeTransport,
										cdp: {
											available: cdpAvailable,
											debugPortAccessible,
											browserRunning,
										},
										websocket: {
											available: wsConnected,
											serverRunning: wsServer?.isStarted() ?? false,
											port: wsActualPort ? String(wsActualPort) : null,
											preferredPort: String(wsPreferredPort),
											portFallbackUsed: wsActualPort !== null && wsActualPort !== wsPreferredPort,
											startupError: wsStartupError ? {
												code: wsStartupError.code,
												port: wsStartupError.port,
												message: `All ports in range ${wsPreferredPort}-${wsPreferredPort + 9} are in use`,
											} : undefined,
											otherInstances: (() => {
												try {
													const instances = discoverActiveInstances(wsPreferredPort);
													const others = instances.filter(i => i.pid !== process.pid);
													if (others.length === 0) return undefined;
													return others.map(i => ({
														port: i.port,
														pid: i.pid,
														startedAt: i.startedAt,
													}));
												} catch { return undefined; }
											})(),
											connectedFile: wsFileInfo ? {
												fileName: wsFileInfo.fileName,
												fileKey: wsFileInfo.fileKey,
												currentPage: wsFileInfo.currentPage,
												connectedAt: new Date(wsFileInfo.connectedAt).toISOString(),
											} : undefined,
											connectedFiles: (() => {
												const files = wsServer?.getConnectedFiles();
												if (!files || files.length === 0) return undefined;
												return files.map(f => ({
													fileName: f.fileName,
													fileKey: f.fileKey,
													currentPage: f.currentPage,
													isActive: f.isActive,
													connectedAt: new Date(f.connectedAt).toISOString(),
												}));
											})(),
											currentSelection: (() => {
												const sel = wsServer?.getCurrentSelection();
												if (!sel || sel.count === 0) return undefined;
												return {
													count: sel.count,
													nodes: sel.nodes.slice(0, 5).map((n: any) => `${n.name} (${n.type})`),
													page: sel.page,
												};
											})(),
										},
									},
									setup: {
										valid: setupValid,
										message: activeTransport === "cdp"
											? "✅ Connected to Figma Desktop via CDP (Chrome DevTools Protocol)"
											: activeTransport === "websocket"
												? wsActualPort !== wsPreferredPort
													? `✅ Connected to Figma Desktop via WebSocket Bridge (port ${wsActualPort}, fallback from ${wsPreferredPort})`
													: "✅ Connected to Figma Desktop via WebSocket Bridge"
												: wsStartupError?.code === "EADDRINUSE"
													? `❌ All WebSocket ports ${wsPreferredPort}-${wsPreferredPort + 9} are in use`
													: wsActualPort !== null && wsActualPort !== wsPreferredPort
													? `❌ WebSocket server running on port ${wsActualPort} (fallback) but no plugin connected. Re-import the Desktop Bridge plugin in Figma to enable multi-port scanning.`
													: "❌ No connection to Figma Desktop",
										setupInstructions: !setupValid
											? wsStartupError?.code === "EADDRINUSE"
												? {
													cause: `All ports in range ${wsPreferredPort}-${wsPreferredPort + 9} are in use by other MCP server instances.`,
													fix: "Close some of the other Claude Desktop tabs or terminal sessions running the MCP server, then restart this one.",
												}
												: {
													option1_websocket: `Open the Desktop Bridge plugin in Figma (Plugins → Development → Figma Desktop Bridge). No special launch flags needed.${pluginPath ? ' Plugin manifest: ' + pluginPath : ''}`,
													option2_cdp: 'Launch Figma with: open -a "Figma" --args --remote-debugging-port=9222',
												}
											: undefined,
										ai_instruction: !setupValid
											? wsStartupError?.code === "EADDRINUSE"
												? `All WebSocket ports in range ${wsPreferredPort}-${wsPreferredPort + 9} are in use — most likely multiple Claude Desktop tabs or terminal sessions are running the Figma Console MCP server. Ask the user to close some sessions and restart.`
												: wsActualPort !== null && wsActualPort !== wsPreferredPort
													? `Server is running on fallback port ${wsActualPort} (port ${wsPreferredPort} was taken by another instance). The Desktop Bridge plugin is not connected — most likely because the plugin has old code that only scans port ${wsPreferredPort}. TELL THE USER: Re-import the Desktop Bridge plugin in Figma (Plugins → Development → Import plugin from manifest) to update it with multi-port scanning support. This is a one-time step.${pluginPath ? ' The manifest file is at: ' + pluginPath : ''}`
													: `No connection to Figma Desktop. The easiest option is to open the Desktop Bridge plugin in Figma. Alternatively, relaunch Figma with --remote-debugging-port=9222 for CDP.${pluginPath ? ' Plugin manifest: ' + pluginPath : ''}`
											: activeTransport === "websocket"
												? `Connected via WebSocket Bridge to "${currentFileName || "unknown file"}" on port ${wsActualPort}. All design tools and console monitoring tools are available. Console logs are captured from the plugin sandbox (code.js). For full-page console monitoring including Figma app internals, add CDP (--remote-debugging-port=9222). IMPORTANT: Always verify the file name before destructive operations when multiple files have the plugin open.`
												: availablePages.length > 1
													? `Multiple Figma pages detected. Current page has ${monitorStatus?.workerCount || 0} workers.`
													: "All tools are ready to use.",
									},
									pluginPath: pluginPath || undefined,
									availablePages:
										availablePages.length > 0 ? availablePages : undefined,
									browser: {
										running: browserRunning,
										currentUrl,
									},
									consoleMonitor: monitorStatus,
									initialized: setupValid,
								},
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get status");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: String(error),
									message: "Failed to retrieve status",
								},
							),
						},
					],
					isError: true,
				};
			}
			}

			case "reconnect": {
			try {
				// Clear cached desktop connector to force fresh detection
				setDesktopConnector(null);

				let transport: string = "none";
				let currentUrl: string | null = null;
				let fileName: string | null = null;
				const browserManager = getBrowserManager();
				const wsServer = getWsServer();

				// Try CDP reconnection if browser manager exists
				if (browserManager) {
					try {
						await browserManager.forceReconnect();

						// Reinitialize console monitor with new page
						const consoleMonitor = getConsoleMonitor();
						if (consoleMonitor) {
							consoleMonitor.stopMonitoring();
							const page = await browserManager.getPage();
							await consoleMonitor.startMonitoring(page);
						}

						currentUrl = getCurrentUrl();
						transport = "cdp";
					} catch (cdpError) {
						logger.debug({ error: cdpError }, "CDP reconnection failed, checking WebSocket");
					}
				}

				// If CDP didn't work, check WebSocket
				if (transport === "none" && wsServer?.isClientConnected()) {
					transport = "websocket";
				}

				if (transport === "none") {
					throw new Error(
						"Cannot connect to Figma Desktop.\n\n" +
						"Option 1 (WebSocket): Open the Desktop Bridge plugin in Figma.\n" +
						"Option 2 (CDP): Launch Figma with --remote-debugging-port=9222"
					);
				}

				// Try to get the file name via whichever transport connected
				try {
					const connector = await getDesktopConnector();
					const fileInfo = await connector.executeCodeViaUI(
						"return { fileName: figma.root.name, fileKey: figma.fileKey }",
						5000,
					);
					if (fileInfo.success && fileInfo.result) {
						fileName = fileInfo.result.fileName;
					}
				} catch {
					// Non-critical - just for context
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status: "reconnected",
									transport,
									currentUrl,
									fileName:
										fileName ||
										"(unknown - Desktop Bridge may need to be restarted)",
									message: fileName
										? `Successfully reconnected via ${transport.toUpperCase()}. Now connected to: "${fileName}"`
										: `Successfully reconnected to Figma Desktop via ${transport.toUpperCase()}.`,
								},
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to reconnect");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error:
										error instanceof Error ? error.message : String(error),
									message: "Failed to reconnect to Figma Desktop",
									hint: "Open the Desktop Bridge plugin in Figma, or launch Figma with --remote-debugging-port=9222",
								},
							),
						},
					],
					isError: true,
				};
			}
			}

			case "reload": {
			try {
				const consoleMonitor = getConsoleMonitor();
				const browserManager = getBrowserManager();
				const wsServer = getWsServer();
				if (clearConsole && consoleMonitor) {
					consoleMonitor.clear();
				}

				let reloaded = false;
				if (browserManager?.isRunning()) {
					const page = await browserManager.getPage();
					await page.reload({ waitUntil: "networkidle2" });
					reloaded = true;
				}

				if (wsServer?.isClientConnected()) {
					// WebSocket: no browser reload needed — plugin stays connected
					reloaded = true;
				}

				if (!reloaded) {
					throw new Error("No active connection to reload. Open the Desktop Bridge plugin or launch Figma with --remote-debugging-port=9222.");
				}

				return {
					content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Plugin reloaded" }) }],
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
			}

			case "list_files": {
			try {
				const wsServer = getWsServer();
				const files = wsServer?.getConnectedFiles();
				if (!files || files.length === 0) {
					return {
						content: [{
							type: "text" as const,
							text: JSON.stringify({
								files: [],
								message: "No files connected via WebSocket. Open the Desktop Bridge plugin in Figma files.",
								ai_instruction: "Use figma_connection action='navigate' with a file URL to switch the active file. All tools target the active file by default.",
							}),
						}],
					};
				}

				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							files: files.map(f => ({
								fileName: f.fileName,
								fileKey: f.fileKey,
								currentPage: f.currentPage,
								isActive: f.isActive,
								connectedAt: new Date(f.connectedAt).toISOString(),
							})),
							totalFiles: files.length,
							activeFile: files.find(f => f.isActive)?.fileName ?? null,
						}),
					}],
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
			}

			case "changes": {
			try {
				const wsServer = getWsServer();
				const changes = wsServer?.getDocumentChanges?.({ since, count }) ?? [];

				if (clear && wsServer?.clearDocumentChanges) {
					wsServer.clearDocumentChanges();
				}

				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							changes,
							returned: changes.length,
							cleared: clear,
						}),
					}],
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
			}

			case "invalidate_cache": {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ error: "No Figma file connected. Pass a fileUrl or open a file first." }) }],
						isError: true,
					};
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ error: `Could not extract file key from URL: ${url}` }) }],
						isError: true,
					};
				}

				// Clear all cache layers for this file
				variablesCache.delete(fileKey);
				sessionCache.invalidateFile(fileKey);

				// Force-rebuild project context (invalidates disk + memory, then rebuilds)
				const api = await getFigmaAPI();
				const ctx = await projectContextCache.forceRebuild(fileKey, api);

				// Also invalidate team library caches (team libraries may reference this file)
				const teamLibraryRebuilt: string[] = [];
				if (teamIds.length > 0) {
					for (const teamId of teamIds) {
						await teamLibraryCache.invalidate(teamId);
						teamLibraryCache.build(teamId, api).catch(() => {});
						teamLibraryRebuilt.push(teamId);
					}
				}

				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
							fileKey,
							fileName: ctx.fileName,
							summary: ctx.summary,
							variables: {
								source: ctx.variables.source,
								totalVariables: ctx.variables.totalVariables,
								collections: ctx.variables.collections.length,
								sourceError: ctx.variables.sourceError,
							},
							components: { total: ctx.components.total, withKeys: Object.keys(ctx.components.keyMap).length },
							componentSets: { total: ctx.componentSets.total, withKeys: Object.keys(ctx.componentSets.keyMap).length },
							styles: ctx.styles,
							generatedAt: ctx.generatedAt,
							...(teamLibraryRebuilt.length > 0 && { teamLibrariesInvalidated: teamLibraryRebuilt }),
						}),
					}],
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
			}
			}
		},
	);

	// Tool: Get current user selection in Figma
	server.tool(
		"figma_get_selection",
		"Get the currently selected nodes in Figma. Returns node IDs, names, types, and dimensions. WebSocket-only — requires Desktop Bridge plugin. Use this to understand what the user is pointing at instead of asking them to describe it.",
		{
			verbose: z
				.boolean()
				.optional()
				.default(false)
				.describe("If true, fetches additional details (fills, strokes, styles) for each selected node via internal plugin execution"),
		},
		{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async ({ verbose }) => {
			try {
				const wsServer = getWsServer();
				const selection = wsServer?.getCurrentSelection() ?? null;

				if (!wsServer?.isClientConnected()) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: "WebSocket not connected. Open the Desktop Bridge plugin in Figma.",
								selection: null,
							}),
						}],
						isError: true,
					};
				}

				if (!selection || selection.count === 0) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								selection: [],
								count: 0,
								page: selection?.page ?? "unknown",
								message: "Nothing is selected in Figma. Select one or more elements to use this tool.",
							}),
						}],
					};
				}

				let result: Record<string, any> = {
					selection: selection.nodes,
					count: selection.count,
					page: selection.page,
					timestamp: selection.timestamp,
				};

				// If verbose, fetch additional details for selected nodes
				if (verbose && selection.nodes.length > 0 && selection.nodes.length <= 10) {
					try {
						const connector = await getDesktopConnector();
						const nodeIds = selection.nodes.map((n: any) => `"${n.id}"`).join(",");
						const details = await connector.executeCodeViaUI(
							`var ids = [${nodeIds}];
							var results = [];
							for (var i = 0; i < ids.length; i++) {
								var node = await figma.getNodeByIdAsync(ids[i]);
								if (!node) continue;
								var info = { id: node.id, name: node.name, type: node.type };
								if ('fills' in node) info.fills = node.fills;
								if ('strokes' in node) info.strokes = node.strokes;
								if ('effects' in node) info.effects = node.effects;
								if ('characters' in node) info.characters = node.characters;
								if ('fontSize' in node) info.fontSize = node.fontSize;
								if ('fontName' in node) info.fontName = node.fontName;
								if ('opacity' in node) info.opacity = node.opacity;
								if ('cornerRadius' in node) info.cornerRadius = node.cornerRadius;
								if ('componentProperties' in node) info.componentProperties = node.componentProperties;
								results.push(info);
							}
							return results;`,
							10000,
						);
						if (details.success && details.result) {
							result.details = details.result;
						}
					} catch (err) {
						result.detailsError = "Could not fetch detailed properties";
					}
				}

				return {
					content: [{
						type: "text",
						text: JSON.stringify(result),
					}],
				};
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							message: "Failed to get selection",
						}),
					}],
					isError: true,
				};
			}
		},
	);
}
