/**
 * Figma Batch Tool
 * Executes multiple Figma tools in a single MCP request.
 * Each operation runs independently — if one fails, others still succeed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";
import { sendProgress } from "./progress.js";

const logger = createChildLogger({ component: "batch-tool" });

const OPERATION_TIMEOUT_MS = 30_000;
const MAX_OPERATIONS = 25;

interface OperationResult {
	id: string;
	tool: string;
	success: boolean;
	result?: unknown;
	error?: string;
	durationMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Operation timed out after ${ms}ms`)),
			ms,
		);
		promise.then(
			(val) => {
				clearTimeout(timer);
				resolve(val);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export function registerBatchTool(server: McpServer): void {
	server.tool(
		"figma_batch",
		"Execute multiple Figma tools in a single batch request. Each operation runs independently — if one fails, others still succeed. Recommended batch-friendly tools: figma_get_file_data, figma_get_variables, figma_get_styles, figma_find_components, figma_get_selection, figma_get_library_components. Screenshot tools (figma_screenshot) return large payloads that can overflow batch responses — call those as standalone requests instead.",
		{
			operations: z
				.array(
					z.object({
						tool: z
							.string()
							.describe(
								"Name of the Figma tool to call (e.g., 'figma_get_file_data', 'figma_get_variables')",
							),
						args: z
							.record(z.any())
							.optional()
							.default({})
							.describe("Arguments to pass to the tool"),
						id: z
							.string()
							.optional()
							.describe(
								"Optional identifier to label this operation in the results",
							),
					}),
				)
				.min(1)
				.max(MAX_OPERATIONS)
				.describe("Array of tool operations to execute (1-25)"),
			parallel: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"Execute operations in parallel (default) or sequentially",
				),
			verbose: z
				.boolean()
				.optional()
				.default(false)
				.describe("Return full sub-tool responses (true) or compact result summaries (false). Default: false. Compact summaries are usually sufficient — verbose responses can be very large and may overflow context."),
		},
		{
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		async ({ operations, parallel, verbose }, extra) => {
			const registeredTools = (server as any)._registeredTools as Record<
				string,
				any
			>;

			// Validate all operations upfront
			for (const op of operations) {
				if (op.tool === "figma_batch") {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: figma_batch cannot call itself recursively.",
							},
						],
						isError: true,
					};
				}
				if (!registeredTools[op.tool]) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Unknown tool "${op.tool}". Use a valid registered tool name.`,
							},
						],
						isError: true,
					};
				}
			}

			async function executeOperation(
				op: (typeof operations)[number],
				index: number,
			): Promise<OperationResult> {
				const id = op.id || `op_${index}`;
				const start = Date.now();

				try {
					const tool = registeredTools[op.tool];

					// Validate args against the tool's input schema
					let parsedArgs = op.args;
					if (tool.inputSchema) {
						parsedArgs = await tool.inputSchema.parseAsync(op.args);
					}

					// Execute the tool handler with timeout
					const result = await withTimeout(
						Promise.resolve(tool.handler(parsedArgs, extra)),
						OPERATION_TIMEOUT_MS,
					);

					return {
						id,
						tool: op.tool,
						success: !result.isError,
						result: result.content,
						durationMs: Date.now() - start,
					};
				} catch (err: any) {
					logger.error(
						`Batch operation ${id} (${op.tool}) failed: ${err.message}`,
					);
					return {
						id,
						tool: op.tool,
						success: false,
						error: err.message || String(err),
						durationMs: Date.now() - start,
					};
				}
			}

			let results: OperationResult[];
			const total = operations.length;
			if (parallel) {
				await sendProgress(extra, 0, total, `Executing ${total} operations in parallel...`);
				results = await Promise.all(
					operations.map((op, i) => executeOperation(op, i)),
				);
				await sendProgress(extra, total, total, `All ${total} operations complete`);
			} else {
				results = [];
				await sendProgress(extra, 0, total, `Executing ${total} operations sequentially...`);
				for (let i = 0; i < operations.length; i++) {
					results.push(await executeOperation(operations[i], i));
					await sendProgress(extra, i + 1, total, `Completed ${i + 1}/${total}: ${operations[i].tool}`);
				}
			}

			const succeeded = results.filter((r) => r.success).length;
			const failed = results.length - succeeded;

			const header = `Batch: ${succeeded}/${results.length} succeeded${failed > 0 ? `, ${failed} failed` : ""}`;

			// Format each result as readable text
			const lines: string[] = [header, ""];
			for (const r of results) {
				// Extract the text content from the sub-tool response
				let body = "";
				if (r.error) {
					body = `Error: ${r.error}`;
				} else if (r.result) {
					const content = Array.isArray(r.result) ? r.result : [r.result];
					const textContent = content.find((c: any) => c.type === "text");
					body = textContent?.text || "(no output)";
					// If the sub-tool returned JSON (legacy/non-node tools), try to extract a summary
					if (body.startsWith("{") || body.startsWith("[")) {
						try {
							const parsed = JSON.parse(body);
							if (parsed.message) body = parsed.message;
							else if (parsed.summary) body = parsed.summary;
							else if (parsed.error) body = `Error: ${parsed.error}`;
							else if (!verbose) {
								// Compact: show only key fields
								const compactKeys = ["summary", "id", "name", "type", "count", "success", "message", "applied", "hint", "error"];
								const compact: Record<string, unknown> = {};
								for (const key of compactKeys) {
									if (key in parsed) compact[key] = parsed[key];
								}
								body = Object.keys(compact).length > 0 ? JSON.stringify(compact) : body;
							}
						} catch {
							// Keep as-is if not parseable
						}
					}
				}

				const status = r.success ? "ok" : "FAIL";
				const prefix = `[${r.id}] ${r.tool} — ${status}`;

				// Indent multi-line bodies under the prefix
				const bodyLines = body.split("\n");
				if (bodyLines.length === 1) {
					lines.push(`${prefix}: ${body}`);
				} else {
					lines.push(`${prefix}:`);
					for (const bl of bodyLines) {
						lines.push(`  ${bl}`);
					}
				}
			}

			if (verbose) {
				const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
				lines.push("", `Total time: ${totalMs}ms`);
			}

			return {
				content: [
					{
						type: "text" as const,
						text: lines.join("\n"),
					},
				],
			};
		},
	);

	logger.info("Registered figma_batch tool");
}
