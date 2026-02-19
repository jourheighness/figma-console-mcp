/**
 * MCP Progress Reporting Utility
 * Sends progress notifications for long-running tool operations.
 */

import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "progress" });

interface ProgressExtra {
	_meta?: { progressToken?: string | number };
	sendNotification: (notification: ServerNotification) => Promise<void>;
}

export async function sendProgress(
	extra: ProgressExtra | undefined,
	progress: number,
	total?: number,
	message?: string,
): Promise<void> {
	const token = extra?._meta?.progressToken;
	if (!token || !extra?.sendNotification) {
		logger.debug({ hasToken: !!token, hasSendNotification: !!extra?.sendNotification, hasExtra: !!extra, meta: extra?._meta }, "Progress skipped — no token or sendNotification from client");
		return;
	}

	logger.debug({ token, progress, total, message }, "Sending progress notification");
	await extra.sendNotification({
		method: "notifications/progress",
		params: { progressToken: token, progress, total, message },
	});
}
