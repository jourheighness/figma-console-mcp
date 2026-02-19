/**
 * Figma Comments MCP Tools
 * Unified tool for getting, posting, and deleting comments on Figma files via REST API.
 * Works in both local and Cloudflare Workers modes — no Plugin API dependency.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey } from "./figma-api.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "comment-tools" });

// ============================================================================
// Tool Registration
// ============================================================================

export function registerCommentTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
	options?: { isRemoteMode?: boolean },
): void {
	server.tool(
		"figma_comments",
		`Manage comments on a Figma file. Actions:
- get: Retrieve comment threads (author, message, timestamps, pinned nodes). Use include_resolved for resolved threads.
- post: Post a comment, optionally pinned to a node. Supports replies. Note: @mentions render as plain text (Figma UI-only feature).
- delete: Delete a comment by ID. Use action='get' to find comment IDs first.`,
		{
			action: z.enum(["get", "post", "delete"]).describe("Comment operation"),
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			// get-specific
			as_md: z
				.boolean()
				.optional()
				.default(false)
				.describe("Return comment message bodies as markdown (get only)"),
			include_resolved: z
				.boolean()
				.optional()
				.default(false)
				.describe("Include resolved comment threads (get only)"),
			verbose: z
				.boolean()
				.optional()
				.default(false)
				.describe("Return full comment objects with all metadata (get only)"),
			// post-specific
			message: z
				.string()
				.optional()
				.describe("Comment message text (required for post)"),
			node_id: z
				.string()
				.optional()
				.describe("Node ID to pin comment to (post only, e.g., '695:313')"),
			x: z
				.number()
				.optional()
				.describe("X coordinate for comment placement (post only, used with node_id)"),
			y: z
				.number()
				.optional()
				.describe("Y coordinate for comment placement (post only, used with node_id)"),
			reply_to_comment_id: z
				.string()
				.optional()
				.describe("Reply to existing comment thread (post only)"),
			// delete-specific
			comment_id: z
				.string()
				.optional()
				.describe("Comment ID to delete (required for delete)"),
		},
		{
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		async ({ action, fileUrl, as_md, include_resolved, verbose, message, node_id, x, y, reply_to_comment_id, comment_id }) => {
			// Common URL resolution
			const url = fileUrl || getCurrentUrl();
			if (!url) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "no_file_url",
								message:
									"No Figma file URL available. Pass the fileUrl parameter, or ensure a file is connected.",
								ai_instruction: "No file URL could be resolved. Either pass the fileUrl parameter directly, or connect to a file first, then retry.",
							}),
						},
					],
					isError: true,
				};
			}

			const fileKey = extractFileKey(url);
			if (!fileKey) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "invalid_url",
								message: `Invalid Figma URL: ${url}`,
							}),
						},
					],
					isError: true,
				};
			}

			try {
				const api = await getFigmaAPI();

				switch (action) {
					case "get": {
						logger.info({ fileKey, as_md, include_resolved }, "Fetching comments");

						const response = await api.getComments(fileKey, { as_md: as_md ?? false });
						const allComments: any[] = response.comments || [];

						const comments = include_resolved
							? allComments
							: allComments.filter((c: any) => !c.resolved_at);

						const compactComments = verbose
							? comments
							: comments.map((c: any) => ({
								id: c.id,
								message: c.message,
								user: c.user?.handle,
								node_id: c.client_meta?.node_id,
								created_at: c.created_at,
							}));

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										comments: compactComments,
										summary: {
											total: allComments.length,
											active: allComments.filter((c: any) => !c.resolved_at).length,
											resolved: allComments.filter((c: any) => c.resolved_at).length,
											returned: comments.length,
										},
									}),
								},
							],
						};
					}

					case "post": {
						if (!message) {
							return {
								content: [{ type: "text" as const, text: JSON.stringify({ error: "message is required for post action" }) }],
								isError: true,
							};
						}

						logger.info({ fileKey, node_id, reply_to_comment_id }, "Posting comment");

						let clientMeta: { node_id?: string; node_offset?: { x: number; y: number } } | undefined;
						if (node_id) {
							clientMeta = {
								node_id,
								node_offset: { x: x ?? 0, y: y ?? 0 },
							};
						}

						const result = await api.postComment(
							fileKey,
							message,
							clientMeta,
							reply_to_comment_id,
						);

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										success: true,
										comment: {
											id: result.id,
											message: result.message,
											created_at: result.created_at,
											user: result.user,
											client_meta: result.client_meta,
											order_id: result.order_id,
										},
									}),
								},
							],
						};
					}

					case "delete": {
						if (!comment_id) {
							return {
								content: [{ type: "text" as const, text: JSON.stringify({ error: "comment_id is required for delete action" }) }],
								isError: true,
							};
						}

						logger.info({ fileKey, comment_id }, "Deleting comment");
						await api.deleteComment(fileKey, comment_id);

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										success: true,
										deleted_comment_id: comment_id,
									}),
								},
							],
						};
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				logger.error({ error }, `Failed comment operation: ${action}`);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: `${action}_failed`,
								message: `Cannot ${action} comment. ${errorMessage}`,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
