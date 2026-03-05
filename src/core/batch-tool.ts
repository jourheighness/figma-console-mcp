/**
 * Figma Batch Tool
 * Executes multiple Figma tools in a single MCP request.
 * Each operation runs independently — if one fails, others still succeed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonArray } from "./schema-coerce.js";
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

/** Count nodes in a nested children tree (recursive). */
function countTreeNodes(children: any[]): number {
	let count = 0;
	for (const child of children) {
		count += 1;
		if (child.children && Array.isArray(child.children)) {
			count += countTreeNodes(child.children);
		}
	}
	return count;
}

/**
 * Hard-reject operations too complex for batch execution.
 * Returns an error message string, or null if all operations are OK.
 */
function checkBatchComplexity(operations: { tool: string; args?: Record<string, any>; id?: string }[]): string | null {
	const rejected: string[] = [];

	for (let i = 0; i < operations.length; i++) {
		const op = operations[i];
		const id = op.id || `op_${i}`;
		const args = op.args || {};

		// figma_create_nodes with nested children — this is where LLMs spiral
		if (op.tool === "figma_create_nodes" && args.children) {
			let children: any[];
			try {
				children = typeof args.children === "string" ? JSON.parse(args.children) : args.children;
			} catch {
				continue; // let the tool itself handle parse errors
			}
			if (Array.isArray(children) && children.length > 0) {
				const totalNodes = countTreeNodes(children);
				rejected.push(
					`[${id}] figma_create_nodes with ${totalNodes} nested child node${totalNodes > 1 ? "s" : ""} — too complex for batch. Call this standalone so errors are isolated and layout is applied correctly.`
				);
			}
		}

		// figma_instantiate_component — instance creation with overrides can be complex
		if (op.tool === "figma_instantiate_component" && args.overrides) {
			let overrides: any;
			try {
				overrides = typeof args.overrides === "string" ? JSON.parse(args.overrides) : args.overrides;
			} catch {
				continue;
			}
			if (overrides && typeof overrides === "object" && Object.keys(overrides).length > 5) {
				rejected.push(
					`[${id}] figma_instantiate_component with ${Object.keys(overrides).length} overrides — too complex for batch. Call standalone to debug override failures individually.`
				);
			}
		}
	}

	if (rejected.length === 0) return null;

	return `Batch rejected — ${rejected.length} operation${rejected.length > 1 ? "s" : ""} too complex for batch execution:\n\n${rejected.join("\n\n")}\n\nCall these tools as standalone requests instead. Batch is for reads and simple per-node writes, not nested tree construction.`;
}

export function registerBatchTool(server: McpServer): void {
	server.tool(
		"figma_batch",
		"Execute multiple Figma tools in a single batch request. Each operation runs independently — if one fails, others still succeed. Best for: read operations (figma_get_file_data, figma_get_variables, figma_get_styles, figma_find_components, figma_get_selection, figma_get_library_components, figma_find_node) and simple write operations (figma_edit_node, figma_set_appearance, figma_set_text on individual nodes). Do NOT batch complex tree creation — figma_create_nodes with nested children, component instantiation with layout setup, or multi-step component assembly should be called one at a time as standalone requests. Batching complex nested structures causes timeouts and layout errors. figma_screenshot returns large payloads that overflow batch responses — call standalone.",
		{
			operations: jsonArray(z.array(
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
				.max(MAX_OPERATIONS))
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

			// Reject complex operations that don't belong in batch
			const complexOps = checkBatchComplexity(operations);
			if (complexOps) {
				return {
					content: [{ type: "text" as const, text: complexOps }],
					isError: true,
				};
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
							if (parsed.message) {
								body = parsed.message;
								// Compact: append critical IDs that would otherwise be lost
								if (!verbose) {
									const id = parsed.id || parsed.instance?.id || parsed.style?.id || parsed.variable?.id || parsed.deleted?.id;
									if (id) body += ` (id: ${id})`;
								}
							}
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
