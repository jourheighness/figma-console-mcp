/**
 * Dependency injection interface for local-only tool modules.
 * Each module destructures only what it needs from this object.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaAPI } from "../core/figma-api.js";
import type { IFigmaConnector } from "../core/figma-connector.js";
import type { LocalBrowserManager } from "../browser/local.js";
import type { ConsoleMonitor } from "../core/console-monitor.js";
import type { FigmaWebSocketServer } from "../core/websocket-server.js";
import type { SessionCache } from "../core/session-cache.js";
import type { ProjectContextCache } from "../core/project-context.js";
import type { TeamLibraryCache } from "../core/team-library.js";
import type { getConfig } from "../core/config.js";

export interface LocalToolDeps {
	server: McpServer;
	// Lazy factories (tools registered at startup before state is ready)
	getFigmaAPI: () => Promise<FigmaAPI>;
	getCurrentUrl: () => string | null;
	getDesktopConnector: () => Promise<IFigmaConnector>;
	ensureInitialized: () => Promise<void>;
	// Runtime state accessors
	getBrowserManager: () => LocalBrowserManager | null;
	getConsoleMonitor: () => ConsoleMonitor | null;
	getWsServer: () => FigmaWebSocketServer | null;
	config: ReturnType<typeof getConfig>;
	// Caches
	variablesCache: Map<string, { data: any; timestamp: number }>;
	sessionCache: SessionCache;
	projectContextCache: ProjectContextCache;
	teamLibraryCache: TeamLibraryCache;
	designSystems: Map<string, string>;
	// Connection state
	getDesktopConnectorRaw: () => IFigmaConnector | null;
	setDesktopConnector: (connector: IFigmaConnector | null) => void;
	getWsActualPort: () => number | null;
	getWsPreferredPort: () => number;
	getWsStartupError: () => { code: string; port: number } | null;
	getPluginPath: () => string | null;
}
