/**
 * Node manipulation tools — edit, appearance, text, create, layout, page, reaction, style.
 * All operate via Desktop Bridge connector.
 */

import { z } from "zod";
import { createChildLogger } from "../core/logger.js";
import type { LocalToolDeps } from "./types.js";

const logger = createChildLogger({ component: "node-tools" });

/** Format a node object into a readable summary line */
function fmtNode(node: any): string {
	if (!node) return "";
	const parts: string[] = [];
	if (node.id) parts.push(node.id);
	if (node.name) parts.push(`"${node.name}"`);
	if (node.type) parts.push(node.type);
	if (node.width !== undefined && node.height !== undefined) parts.push(`${Math.round(node.width)}x${Math.round(node.height)}`);
	return parts.join("  ");
}

/** Format a success response */
function ok(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

/** Format an error response */
function err(message: string, hint?: string) {
	let text = `Error: ${message}`;
	if (hint) text += `\nHint: ${hint}`;
	return { content: [{ type: "text" as const, text }], isError: true as const };
}

export function registerNodeTools(deps: LocalToolDeps): void {
	const { server, getDesktopConnector } = deps;

	// Tool: Edit Node (resize, move, clone, delete, rename, reparent, reorder)
	server.tool(
		"figma_edit_node",
		`Perform structural node operations: resize, move, clone, delete, rename, reparent (move to new parent), or reorder (change z-order).

Actions and required params:
- resize: width, height (optional: withConstraints)
- move: x, y
- clone: (no extra params — returns cloned node info)
- delete: (no extra params — destructive, undoable via Figma)
- rename: newName
- reparent: newParentId (optional: insertIndex)
- reorder: insertIndex (z-order position within current parent, 0 = bottom)`,
		{
			nodeId: z.string().describe("The node ID to operate on"),
			action: z.enum(["resize", "move", "clone", "delete", "rename", "reparent", "reorder"]).describe("Operation to perform"),
			width: z.number().optional().describe("New width (resize)"),
			height: z.number().optional().describe("New height (resize)"),
			withConstraints: z.boolean().optional().default(true).describe("Respect child constraints during resize (default: true)"),
			x: z.number().optional().describe("New X position (move)"),
			y: z.number().optional().describe("New Y position (move)"),
			newName: z.string().optional().describe("New name (rename)"),
			newParentId: z.string().optional().describe("Target parent node ID (reparent)"),
			insertIndex: z.number().optional().describe("Child index position (reparent, reorder). 0 = bottom/first."),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async ({ nodeId, action, width, height, withConstraints, x, y, newName, newParentId, insertIndex }) => {
			try {
				const connector = await getDesktopConnector();
				let result: any;
				let message: string;

				switch (action) {
					case "resize":
						if (width === undefined || height === undefined) throw new Error("resize requires width and height");
						result = await connector.resizeNode(nodeId, width, height, withConstraints);
						message = `Node resized to ${width}x${height}`;
						break;
					case "move":
						if (x === undefined || y === undefined) throw new Error("move requires x and y");
						result = await connector.moveNode(nodeId, x, y);
						message = `Node moved to (${x}, ${y})`;
						break;
					case "clone":
						result = await connector.cloneNode(nodeId);
						message = "Node cloned";
						break;
					case "delete":
						result = await connector.deleteNode(nodeId);
						message = "Node deleted";
						break;
					case "rename":
						if (!newName) throw new Error("rename requires newName");
						result = await connector.renameNode(nodeId, newName);
						message = `Node renamed to "${newName}"`;
						break;
					case "reparent":
						if (!newParentId) throw new Error("reparent requires newParentId");
						result = await connector.reparentNode(nodeId, newParentId, insertIndex);
						message = `Node reparented to ${newParentId}`;
						break;
					case "reorder":
						if (insertIndex === undefined) throw new Error("reorder requires insertIndex");
						result = await connector.reorderNode(nodeId, insertIndex);
						message = `Node reordered to index ${insertIndex}`;
						break;
					default:
						throw new Error(`Unknown action: ${action}`);
				}

				if (!result.success) {
					throw new Error(result.error || `Failed to ${action} node`);
				}

				const node = result.node || result.clonedNode || result.deleted;
				const nodeLine = fmtNode(node);
				return ok(nodeLine ? `${message}\n  ${nodeLine}` : message);
			} catch (error) {
				logger.error({ error }, `Failed to edit node (${action})`);
				return err(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// Tool: Set Node Appearance (fills, strokes, opacity, cornerRadius, effects, rotation, blendMode)
	server.tool(
		"figma_set_appearance",
		`Set visual appearance properties on a node. Combines fills, strokes, opacity, corner radius, effects (shadows/blurs), rotation, and blend mode into a single tool.

Color format: hex strings like '#FF0000' or '#FF000080' (with alpha). Gradient fills use type 'GRADIENT_LINEAR'/'GRADIENT_RADIAL' with gradientStops array. gradientTransform defaults to left-to-right if omitted.`,
		{
			nodeId: z.string().describe("The node ID to modify"),
			fills: z
				.array(
					z.union([
						z.object({
							type: z.literal("SOLID").describe("Solid fill"),
							color: z.string().describe("Hex color string"),
							opacity: z.number().optional().describe("Opacity 0-1"),
						}),
						z.object({
							type: z.enum(["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]).describe("Gradient type"),
							gradientStops: z.array(z.object({
								position: z.number().describe("Stop position 0-1"),
								color: z.string().describe("Hex color string"),
							})).describe("Gradient color stops"),
							gradientTransform: z.array(z.array(z.number()).length(3)).length(2).optional()
								.describe("2x3 affine transform matrix [[a,b,tx],[c,d,ty]]. Default: left-to-right linear."),
							opacity: z.number().optional().describe("Opacity 0-1"),
						}),
					])
				)
				.optional()
				.describe("Fill paints array (solid or gradient)"),
			strokes: z
				.array(
					z.object({
						type: z.literal("SOLID").describe("Stroke type"),
						color: z.string().describe("Hex color string"),
						opacity: z.number().optional().describe("Opacity 0-1"),
					}),
				)
				.optional()
				.describe("Stroke paints array"),
			strokeWeight: z.number().optional().describe("Stroke thickness in pixels"),
			strokeAlign: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional().describe("Stroke alignment"),
			strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]).optional().describe("Stroke cap style"),
			dashPattern: z.array(z.number()).optional().describe("Dash pattern [dash, gap] in pixels (e.g., [5, 3])"),
			opacity: z.number().min(0).max(1).optional().describe("Node opacity 0-1"),
			cornerRadius: z.number().optional().describe("Uniform corner radius in pixels"),
			cornerRadii: z.object({
				topLeft: z.number(),
				topRight: z.number(),
				bottomRight: z.number(),
				bottomLeft: z.number(),
			}).optional().describe("Individual corner radii (overrides cornerRadius)"),
			rotation: z.number().optional().describe("Rotation in degrees (0-360)"),
			effects: z.array(z.object({
				type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]).describe("Effect type"),
				visible: z.boolean().optional().default(true).describe("Whether effect is visible"),
				radius: z.number().optional().describe("Blur radius"),
				color: z.string().optional().describe("Shadow color (hex)"),
				offset: z.object({
					x: z.number(),
					y: z.number(),
				}).optional().describe("Shadow offset (for shadow types)"),
				spread: z.number().optional().describe("Shadow spread (for shadow types)"),
				blendMode: z.enum([
					"NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LIGHTEN", "SCREEN",
					"COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE",
					"EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
				]).optional().default("NORMAL").describe("Blend mode for this effect"),
			})).optional().describe("Effects array (shadows, blurs)"),
			blendMode: z.enum([
				"NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LIGHTEN", "SCREEN",
				"COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE",
				"EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
			]).optional().describe("Blend mode"),
			fillStyleId: z.string().optional().describe("Paint style ID to apply as fill (from figma_create_style list). Empty string to detach."),
			strokeStyleId: z.string().optional().describe("Paint style ID to apply as stroke. Empty string to detach."),
			effectStyleId: z.string().optional().describe("Effect style ID to apply. Empty string to detach."),
			variableBindings: z.array(z.object({
				field: z.enum([
					"fills", "strokes", "opacity", "cornerRadius",
					"topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius",
					"strokeWeight", "rotation", "visible",
				]).describe("Node property to bind"),
				variableId: z.string().describe("Variable ID (e.g. 'VariableID:123:456'). Empty string to unbind."),
				paintIndex: z.number().optional().describe("Paint index within fills/strokes array (default: 0). Only for fills/strokes fields."),
			})).optional().describe("Bind variables to node properties. Use figma_get_variables to get variable IDs first."),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async ({ nodeId, fills, strokes, strokeWeight, strokeAlign, strokeCap, dashPattern, opacity, cornerRadius, cornerRadii, rotation, effects, blendMode, fillStyleId, strokeStyleId, effectStyleId, variableBindings }) => {
			try {
				const connector = await getDesktopConnector();
				const applied: string[] = [];

				// Use existing connector methods for fills, strokes, opacity, cornerRadius
				if (fills !== undefined) {
					const result = await connector.setNodeFills(nodeId, fills);
					if (!result.success) throw new Error(result.error || "Failed to set fills");
					applied.push("fills");
				}

				if (strokes !== undefined) {
					const result = await connector.setNodeStrokes(nodeId, strokes, strokeWeight);
					if (!result.success) throw new Error(result.error || "Failed to set strokes");
					applied.push("strokes");
				} else if (strokeWeight !== undefined) {
					// strokeWeight without new strokes — update weight only
					const result = await connector.setNodeStrokes(nodeId, [], strokeWeight);
					if (!result.success) throw new Error(result.error || "Failed to set stroke weight");
					applied.push("strokeWeight");
				}

				if (opacity !== undefined) {
					const result = await connector.setNodeOpacity(nodeId, opacity);
					if (!result.success) throw new Error(result.error || "Failed to set opacity");
					applied.push("opacity");
				}

				if (cornerRadius !== undefined) {
					const result = await connector.setNodeCornerRadius(nodeId, cornerRadius);
					if (!result.success) throw new Error(result.error || "Failed to set corner radius");
					applied.push("cornerRadius");
				}

				// Properties that need executeCodeViaUI
				const codeLines: string[] = [];
				codeLines.push(`var node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});`);
				codeLines.push(`if (!node) throw new Error('Node not found: ${nodeId}');`);
				let needsCodeExec = false;

				if (cornerRadii !== undefined) {
					codeLines.push(`node.topLeftRadius = ${cornerRadii.topLeft};`);
					codeLines.push(`node.topRightRadius = ${cornerRadii.topRight};`);
					codeLines.push(`node.bottomRightRadius = ${cornerRadii.bottomRight};`);
					codeLines.push(`node.bottomLeftRadius = ${cornerRadii.bottomLeft};`);
					applied.push("cornerRadii");
					needsCodeExec = true;
				}

				if (strokeAlign !== undefined) {
					codeLines.push(`node.strokeAlign = '${strokeAlign}';`);
					applied.push("strokeAlign");
					needsCodeExec = true;
				}

				if (strokeCap !== undefined) {
					codeLines.push(`node.strokeCap = '${strokeCap}';`);
					applied.push("strokeCap");
					needsCodeExec = true;
				}

				if (dashPattern !== undefined) {
					codeLines.push(`node.dashPattern = ${JSON.stringify(dashPattern)};`);
					applied.push("dashPattern");
					needsCodeExec = true;
				}

				if (rotation !== undefined) {
					codeLines.push(`node.rotation = ${rotation};`);
					applied.push("rotation");
					needsCodeExec = true;
				}

				if (effects !== undefined) {
					// Build effects array with proper Figma color format
					const effectsCode = effects.map(e => {
						const parts: string[] = [`type: '${e.type}'`, `visible: ${e.visible !== false}`];
						if (e.radius !== undefined) parts.push(`radius: ${e.radius}`);
						if (e.color) {
							// Parse hex to Figma RGBA
							parts.push(`color: (function(){ var h='${e.color}'.replace('#',''); var r=parseInt(h.substr(0,2),16)/255; var g=parseInt(h.substr(2,2),16)/255; var b=parseInt(h.substr(4,2),16)/255; var a=h.length>6?parseInt(h.substr(6,2),16)/255:1; return {r:r,g:g,b:b,a:a}; })()`);
						}
						if (e.offset) parts.push(`offset: {x:${e.offset.x},y:${e.offset.y}}`);
						if (e.spread !== undefined) parts.push(`spread: ${e.spread}`);
						// blendMode only valid on shadow effects, not blur effects
						const isShadow = e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW';
						if (isShadow && e.blendMode) parts.push(`blendMode: '${e.blendMode}'`);
						return `{${parts.join(',')}}`;
					}).join(',');
					codeLines.push(`node.effects = [${effectsCode}];`);
					applied.push("effects");
					needsCodeExec = true;
				}

				if (blendMode !== undefined) {
					codeLines.push(`node.blendMode = '${blendMode}';`);
					applied.push("blendMode");
					needsCodeExec = true;
				}

				if (fillStyleId !== undefined) {
					codeLines.push(`await node.setFillStyleIdAsync(${JSON.stringify(fillStyleId)});`);
					applied.push("fillStyleId");
					needsCodeExec = true;
				}
				if (strokeStyleId !== undefined) {
					codeLines.push(`await node.setStrokeStyleIdAsync(${JSON.stringify(strokeStyleId)});`);
					applied.push("strokeStyleId");
					needsCodeExec = true;
				}
				if (effectStyleId !== undefined) {
					codeLines.push(`await node.setEffectStyleIdAsync(${JSON.stringify(effectStyleId)});`);
					applied.push("effectStyleId");
					needsCodeExec = true;
				}

				if (variableBindings !== undefined) {
					const paintFields = ["fills", "strokes"];
					for (const binding of variableBindings) {
						if (paintFields.includes(binding.field)) {
							const idx = binding.paintIndex ?? 0;
							if (binding.variableId === "") {
								codeLines.push(`node.setBoundVariable('${binding.field}', ${idx}, null);`);
							} else {
								codeLines.push(`node.setBoundVariable('${binding.field}', ${idx}, await figma.variables.getVariableByIdAsync(${JSON.stringify(binding.variableId)}));`);
							}
						} else {
							if (binding.variableId === "") {
								codeLines.push(`node.setBoundVariable('${binding.field}', null);`);
							} else {
								codeLines.push(`node.setBoundVariable('${binding.field}', await figma.variables.getVariableByIdAsync(${JSON.stringify(binding.variableId)}));`);
							}
						}
						applied.push(`bind:${binding.field}`);
					}
					needsCodeExec = true;
				}

				if (needsCodeExec) {
					codeLines.push(`return { success: true, id: node.id };`);
					const codeResult = await connector.executeCodeViaUI(codeLines.join('\n'));
					if (!codeResult.success && codeResult.error) {
						throw new Error(codeResult.error);
					}
				}

				return ok(`Appearance updated — ${applied.join(", ")}`);
			} catch (error) {
				logger.error({ error }, "Failed to set appearance");
				return err(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// Tool: Set Reaction (Prototyping interactions)
	server.tool(
		"figma_set_reaction",
		`Manage prototyping interactions (reactions) on a node. Supports triggers, actions, transitions, and overlays.

Common patterns:
- Navigate on click: action="add", trigger="ON_CLICK", actionType="NAVIGATE", destinationId="<frame-id>"
- Back on click: action="add", trigger="ON_CLICK", actionType="BACK"
- Open overlay: action="add", trigger="ON_CLICK", actionType="OVERLAY", destinationId="<frame-id>"
- Open URL: action="add", trigger="ON_CLICK", actionType="URL", url="https://..."`,
		{
			nodeId: z.string().describe("The node to add/remove reactions on"),
			action: z.enum(["add", "remove", "list"]).describe("Action to perform"),
			trigger: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS", "MOUSE_ENTER", "MOUSE_LEAVE", "AFTER_TIMEOUT"]).optional().describe("Trigger type (required for add)"),
			actionType: z.enum(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "URL", "BACK", "CLOSE", "SET_VARIABLE"]).optional().describe("Action to perform on trigger (required for add)"),
			destinationId: z.string().optional().describe("Target frame/node ID (for NAVIGATE, SWAP, OVERLAY, SCROLL_TO)"),
			url: z.string().optional().describe("URL to open (for URL action)"),
			timeout: z.number().optional().describe("Timeout in ms (for AFTER_TIMEOUT trigger)"),
			transition: z.object({
				type: z.enum(["DISSOLVE", "SMART_ANIMATE", "SCROLL_ANIMATE"]).describe("Transition type"),
				duration: z.number().optional().default(300).describe("Duration in ms"),
				easing: z.enum(["LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK", "CUSTOM_CUBIC_BEZIER"]).optional().default("EASE_IN_AND_OUT").describe("Easing function"),
			}).optional().describe("Transition animation (only for NODE-type actions: NAVIGATE, SWAP, OVERLAY, SCROLL_TO)"),
			overlayOffset: z.object({ x: z.number(), y: z.number() }).optional().describe("Overlay position offset (for OVERLAY action). Only works if the destination frame's overlayPositionType is already MANUAL (set in Figma UI — read-only in Plugin API)."),
			reactionIndex: z.number().optional().describe("Index of reaction to remove (for remove action)"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async ({ nodeId, action, trigger, actionType, destinationId, url, timeout, transition, overlayOffset, reactionIndex }) => {
			try {
				const connector = await getDesktopConnector();
				const lines: string[] = [];
				lines.push(`var node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});`);
				lines.push(`if (!node) throw new Error('Node not found: ${nodeId}');`);

				if (action === "list") {
					lines.push(`var reactions = node.reactions || [];`);
					lines.push(`return { success: true, reactions: reactions.map(function(r,i) { return { index: i, trigger: r.trigger, actions: r.actions }; }) };`);
				} else if (action === "remove") {
					lines.push(`var reactions = (node.reactions || []).slice();`);
					lines.push(`if (${reactionIndex ?? -1} < 0 || ${reactionIndex ?? -1} >= reactions.length) throw new Error('Invalid reaction index');`);
					lines.push(`reactions.splice(${reactionIndex ?? 0}, 1);`);
					lines.push(`await node.setReactionsAsync(reactions);`);
					lines.push(`return { success: true, remaining: reactions.length };`);
				} else {
					// add
					lines.push(`var reactions = (node.reactions || []).slice();`);

					// Build trigger object
					let triggerObj = `{ type: '${trigger}' }`;
					if (trigger === "AFTER_TIMEOUT" && timeout !== undefined) {
						triggerObj = `{ type: 'AFTER_TIMEOUT', timeout: ${timeout} }`;
					} else if (trigger === "MOUSE_ENTER" || trigger === "MOUSE_LEAVE") {
						triggerObj = `{ type: '${trigger}', delay: 0 }`;
					}

					// Build action object per Figma Plugin API schema
					const nodeActions = ["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO"];
					const isNodeAction = nodeActions.includes(actionType!);
					let actionObj: string;

					if (isNodeAction) {
						// NODE action type — requires: type, destinationId, navigation, transition
						const actionParts: string[] = [
							`type: 'NODE'`,
							`navigation: '${actionType}'`,
							`destinationId: ${destinationId ? JSON.stringify(destinationId) : 'null'}`,
						];

						// Transition (required field, null if not provided)
						if (transition) {
							actionParts.push(`transition: { type: '${transition.type}', duration: ${(transition.duration ?? 300) / 1000}, easing: { type: '${transition.easing ?? "EASE_IN_AND_OUT"}' } }`);
						} else {
							actionParts.push(`transition: null`);
						}

						// Overlay-specific: relative position offset
						if (actionType === "OVERLAY" && overlayOffset) {
							// overlayRelativePosition requires destination overlayPositionType = MANUAL (read-only in Plugin API)
							lines.push(`var destNode = await figma.getNodeByIdAsync(${JSON.stringify(destinationId)});`);
							lines.push(`if (destNode && destNode.overlayPositionType !== 'MANUAL') return { success: false, needsManualStep: true, message: 'The destination frame "' + destNode.name + '" (' + ${JSON.stringify(destinationId)} + ') needs overlayPositionType set to MANUAL before an offset can be applied. Please set this in Figma: select the destination frame → Prototype panel → Overlay Position → Manual, then retry this operation.' };`);
							actionParts.push(`overlayRelativePosition: { x: ${overlayOffset.x}, y: ${overlayOffset.y} }`);
						}

						actionObj = `{ ${actionParts.join(', ')} }`;
					} else if (actionType === "URL") {
						actionObj = `{ type: 'URL', url: ${JSON.stringify(url || '')} }`;
					} else {
						// BACK, CLOSE — simple action types, no transition support
						actionObj = `{ type: '${actionType}' }`;
					}

					lines.push(`var newReaction = { trigger: ${triggerObj}, actions: [${actionObj}] };`);
					lines.push(`reactions.push(newReaction);`);
					lines.push(`await node.setReactionsAsync(reactions);`);
					lines.push(`return { success: true, totalReactions: reactions.length };`);
				}

				const result = await connector.executeCodeViaUI(lines.join('\n'));
				if (result.error) {
					throw new Error(result.error);
				}

				const r = result.result || {};

				// Handle manual step required (e.g. overlay offset needs MANUAL positioning)
				if (r.needsManualStep) {
					return ok(`Action needed: ${r.message}\n\nOnce done, re-run this same operation to complete the reaction setup.`);
				}

				if (action === "list") {
					const reactions = r.reactions || [];
					if (reactions.length === 0) return ok("No reactions on this node");
					const lines2 = reactions.map((rx: any) => {
						const trig = rx.trigger?.type || "?";
						const acts = (rx.actions || []).map((a: any) => a.type === "NODE" ? `${a.navigation} → ${a.destinationId || "?"}` : a.type).join(", ");
						return `  [${rx.index}] ${trig} → ${acts}`;
					});
					return ok(`Reactions (${reactions.length}):\n${lines2.join("\n")}`);
				} else if (action === "remove") {
					return ok(`Reaction removed (${r.remaining ?? 0} remaining)`);
				} else {
					const dest = destinationId ? ` → ${destinationId}` : "";
					return ok(`Reaction added — ${trigger} → ${actionType}${dest} (${r.totalReactions ?? "?"} total)`);
				}
			} catch (error) {
				logger.error({ error }, "Failed to set reaction");
				return err(
					error instanceof Error ? error.message : String(error),
					"Make sure the node supports reactions (frames, components, instances).",
				);
			}
		},
	);

	// Tool: Create/Manage Styles
	server.tool(
		"figma_create_style",
		`Create, update, delete, or list paint/text/effect styles. Styles are reusable design tokens that can be applied to multiple nodes.

Paint styles: solid fills and gradients. Text styles: font properties. Effect styles: shadows and blurs.`,
		{
			action: z.enum(["create", "update", "delete", "list"]).describe("Operation to perform"),
			styleType: z.enum(["paint", "text", "effect"]).optional().describe("Style type (required for create)"),
			name: z.string().optional().describe("Style name (required for create)"),
			description: z.string().optional().describe("Style description"),
			styleId: z.string().optional().describe("Style ID (required for update/delete)"),
			// Paint style properties
			fills: z.array(z.object({
				type: z.enum(["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL"]),
				color: z.string().optional().describe("Hex color (for SOLID)"),
				opacity: z.number().optional(),
				gradientStops: z.array(z.object({
					position: z.number(),
					color: z.string(),
				})).optional().describe("Gradient stops"),
				gradientTransform: z.array(z.array(z.number()).length(3)).length(2).optional()
					.describe("2x3 affine transform matrix [[a,b,tx],[c,d,ty]]. Default: left-to-right linear."),
			})).optional().describe("Fills for paint style"),
			// Text style properties
			fontFamily: z.string().optional(),
			fontStyle: z.string().optional().default("Regular"),
			fontSize: z.number().optional(),
			lineHeight: z.object({
				value: z.number().optional(),
				unit: z.enum(["PIXELS", "PERCENT", "AUTO"]),
			}).optional(),
			letterSpacing: z.object({
				value: z.number(),
				unit: z.enum(["PIXELS", "PERCENT"]).optional().default("PIXELS"),
			}).optional(),
			textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional().describe("Horizontal text alignment"),
			textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional().describe("Vertical text alignment"),
			textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional().describe("How text resizes to fit"),
			textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional().describe("Text decoration"),
			textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional().describe("Text case transformation"),
			paragraphSpacing: z.number().optional().describe("Spacing between paragraphs in px"),
			paragraphIndent: z.number().optional().describe("First-line indent in px"),
			// Effect style properties
			effects: z.array(z.object({
				type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]),
				visible: z.boolean().optional().default(true),
				radius: z.number().optional(),
				color: z.string().optional().describe("Hex color (e.g. '#00000040')"),
				offset: z.object({ x: z.number(), y: z.number() }).optional(),
				spread: z.number().optional(),
				blendMode: z.enum([
					"NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LIGHTEN", "SCREEN",
					"COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE",
					"EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
				]).optional().default("NORMAL").describe("Blend mode for this effect"),
			})).optional().describe("Effects for effect style"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async ({ action, styleType, name, description, styleId, fills, fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, textAlignHorizontal, textAlignVertical, textAutoResize, textDecoration, textCase, paragraphSpacing, paragraphIndent, effects }) => {
			try {
				const connector = await getDesktopConnector();
				const lines: string[] = [];

				if (action === "list") {
					lines.push(`var paintStyles = await figma.getLocalPaintStylesAsync();`);
					lines.push(`var textStyles = await figma.getLocalTextStylesAsync();`);
					lines.push(`var effectStyles = await figma.getLocalEffectStylesAsync();`);
					lines.push(`return { success: true, styles: {`);
					lines.push(`  paint: paintStyles.map(function(s) { return { id: s.id, name: s.name, key: s.key, description: s.description }; }),`);
					lines.push(`  text: textStyles.map(function(s) { return { id: s.id, name: s.name, key: s.key, description: s.description }; }),`);
					lines.push(`  effect: effectStyles.map(function(s) { return { id: s.id, name: s.name, key: s.key, description: s.description }; })`);
					lines.push(`}};`);
				} else if (action === "delete") {
					lines.push(`var style = await figma.getStyleByIdAsync(${JSON.stringify(styleId)});`);
					lines.push(`if (!style) throw new Error('Style not found: ${styleId}');`);
					lines.push(`var n = style.name; style.remove();`);
					lines.push(`return { success: true, deleted: n };`);
				} else if (action === "create" || action === "update") {
					if (action === "create") {
						if (styleType === "paint") {
							lines.push(`var style = figma.createPaintStyle();`);
						} else if (styleType === "text") {
							lines.push(`var style = figma.createTextStyle();`);
						} else if (styleType === "effect") {
							lines.push(`var style = figma.createEffectStyle();`);
						} else {
							throw new Error("styleType is required for create");
						}
					} else {
						lines.push(`var style = await figma.getStyleByIdAsync(${JSON.stringify(styleId)});`);
						lines.push(`if (!style) throw new Error('Style not found: ${styleId}');`);
					}

					if (name) lines.push(`style.name = ${JSON.stringify(name)};`);
					if (description !== undefined) lines.push(`style.description = ${JSON.stringify(description)};`);

					// Paint style fills
					if (fills) {
						const fillsCode = fills.map(f => {
							if (f.type === "SOLID" && f.color) {
								return `(function(){ var h='${f.color}'.replace('#',''); return { type:'SOLID', color:{r:parseInt(h.substr(0,2),16)/255,g:parseInt(h.substr(2,2),16)/255,b:parseInt(h.substr(4,2),16)/255}, opacity:${f.opacity ?? 1} }; })()`;
							}
							if (f.type === "GRADIENT_LINEAR" || f.type === "GRADIENT_RADIAL") {
								// Convert hex colors in gradientStops to RGBA and provide default gradientTransform
								const stopsCode = (f.gradientStops || []).map((s: any) =>
									`(function(){ var h='${s.color}'.replace('#',''); var r=parseInt(h.substr(0,2),16)/255; var g=parseInt(h.substr(2,2),16)/255; var b=parseInt(h.substr(4,2),16)/255; var a=h.length>6?parseInt(h.substr(6,2),16)/255:1; return {position:${s.position},color:{r:r,g:g,b:b,a:a}}; })()`
								).join(',');
								const transform = f.gradientTransform ? JSON.stringify(f.gradientTransform) : '[[1,0,0],[0,1,0]]';
								return `{ type:'${f.type}', gradientStops:[${stopsCode}], gradientTransform:${transform}, opacity:${f.opacity ?? 1} }`;
							}
							return `${JSON.stringify(f)}`;
						}).join(',');
						lines.push(`style.paints = [${fillsCode}];`);
					}

					// Text style properties
					if (fontFamily || fontSize || lineHeight || letterSpacing || textAlignHorizontal || textAlignVertical || textAutoResize || textDecoration || textCase || paragraphSpacing !== undefined || paragraphIndent !== undefined) {
						const family = fontFamily || "Inter";
						const style_name = fontStyle || "Regular";
						lines.push(`await figma.loadFontAsync({family:${JSON.stringify(family)},style:${JSON.stringify(style_name)}});`);
						lines.push(`style.fontName = {family:${JSON.stringify(family)},style:${JSON.stringify(style_name)}};`);
						if (fontSize) lines.push(`style.fontSize = ${fontSize};`);
						if (lineHeight) {
							if (lineHeight.unit === "AUTO") {
								lines.push(`style.lineHeight = {unit:'AUTO'};`);
							} else {
								lines.push(`style.lineHeight = {value:${lineHeight.value},unit:'${lineHeight.unit}'};`);
							}
						}
						if (letterSpacing) {
							lines.push(`style.letterSpacing = {value:${letterSpacing.value},unit:'${letterSpacing.unit || "PIXELS"}'};`);
						}
						if (textAlignHorizontal) lines.push(`style.textAlignHorizontal = '${textAlignHorizontal}';`);
						if (textAlignVertical) lines.push(`style.textAlignVertical = '${textAlignVertical}';`);
						if (textAutoResize) lines.push(`style.textAutoResize = '${textAutoResize}';`);
						if (textDecoration) lines.push(`style.textDecoration = '${textDecoration}';`);
						if (textCase) lines.push(`style.textCase = '${textCase}';`);
						if (paragraphSpacing !== undefined) lines.push(`style.paragraphSpacing = ${paragraphSpacing};`);
						if (paragraphIndent !== undefined) lines.push(`style.paragraphIndent = ${paragraphIndent};`);
					}

					// Effect style
					if (effects) {
						const effectsCode = effects.map(e => {
							const parts: string[] = [`type:'${e.type}'`, `visible:${e.visible !== false}`];
							if (e.radius !== undefined) parts.push(`radius:${e.radius}`);
							if (e.color) {
								parts.push(`color:(function(){var h='${e.color}'.replace('#','');return{r:parseInt(h.substr(0,2),16)/255,g:parseInt(h.substr(2,2),16)/255,b:parseInt(h.substr(4,2),16)/255,a:h.length>6?parseInt(h.substr(6,2),16)/255:1};})()`);
							}
							if (e.offset) parts.push(`offset:{x:${e.offset.x},y:${e.offset.y}}`);
							if (e.spread !== undefined) parts.push(`spread:${e.spread}`);
							// blendMode only valid on shadow effects, not blur effects
							const isShadow = e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW';
							if (isShadow && e.blendMode) parts.push(`blendMode:'${e.blendMode}'`);
							return `{${parts.join(',')}}`;
						}).join(',');
						lines.push(`style.effects = [${effectsCode}];`);
					}

					lines.push(`return { success: true, style: { id: style.id, name: style.name, key: style.key } };`);
				}

				const result = await connector.executeCodeViaUI(lines.join('\n'));
				if (result.error) throw new Error(result.error);

				const r = result.result || {};
				if (action === "list") {
					const sections: string[] = [];
					for (const [type, styles] of Object.entries(r.styles || {})) {
						const list = styles as any[];
						if (list.length === 0) continue;
						sections.push(`${type} (${list.length}):\n${list.map((s: any) => `  ${s.id}  "${s.name}"${s.description ? ` — ${s.description}` : ""}`).join("\n")}`);
					}
					return ok(sections.length ? sections.join("\n\n") : "No local styles found");
				} else if (action === "delete") {
					return ok(`Style deleted — "${r.deleted}"`);
				} else {
					const s = r.style || {};
					return ok(`Style ${action === "create" ? "created" : "updated"} — "${s.name}" (${styleType || "?"})\n  id: ${s.id} | key: ${s.key}`);
				}
			} catch (error) {
				logger.error({ error }, "Failed style operation");
				return err(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// Tool: Manage Pages
	server.tool(
		"figma_manage_page",
		`Create, delete, rename, switch, reorder, or list pages in the current Figma file.`,
		{
			action: z.enum(["create", "delete", "rename", "switch", "reorder", "list"]).describe("Page operation"),
			name: z.string().optional().describe("Page name (for create, or target page for switch)"),
			pageId: z.string().optional().describe("Page ID (for delete, rename, switch, reorder)"),
			newName: z.string().optional().describe("New name (for rename)"),
			index: z.number().optional().describe("Target position index (for reorder, 0-based)"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async ({ action, name, pageId, newName, index }) => {
			try {
				const connector = await getDesktopConnector();
				const lines: string[] = [];

				if (action === "list") {
					lines.push(`return { success: true, pages: figma.root.children.map(function(p,i) { return { id: p.id, name: p.name, index: i, isCurrent: p === figma.currentPage }; }) };`);
				} else if (action === "create") {
					lines.push(`var page = figma.createPage();`);
					if (name) lines.push(`page.name = ${JSON.stringify(name)};`);
					lines.push(`return { success: true, page: { id: page.id, name: page.name } };`);
				} else if (action === "delete") {
					lines.push(`var page = await figma.getNodeByIdAsync(${JSON.stringify(pageId)});`);
					lines.push(`if (!page || page.type !== 'PAGE') throw new Error('Page not found: ${pageId}');`);
					lines.push(`if (figma.root.children.length <= 1) throw new Error('Cannot delete the last page');`);
					lines.push(`var n = page.name; page.remove();`);
					lines.push(`return { success: true, deleted: n };`);
				} else if (action === "rename") {
					lines.push(`var page = await figma.getNodeByIdAsync(${JSON.stringify(pageId)});`);
					lines.push(`if (!page || page.type !== 'PAGE') throw new Error('Page not found: ${pageId}');`);
					lines.push(`page.name = ${JSON.stringify(newName)};`);
					lines.push(`return { success: true, page: { id: page.id, name: page.name } };`);
				} else if (action === "switch") {
					if (pageId) {
						lines.push(`var page = await figma.getNodeByIdAsync(${JSON.stringify(pageId)});`);
					} else if (name) {
						lines.push(`var page = figma.root.children.find(function(p) { return p.name === ${JSON.stringify(name)}; });`);
					} else {
						throw new Error("Provide pageId or name for switch");
					}
					lines.push(`if (!page || page.type !== 'PAGE') throw new Error('Page not found');`);
					lines.push(`await figma.setCurrentPageAsync(page);`);
					lines.push(`return { success: true, currentPage: { id: page.id, name: page.name } };`);
				} else if (action === "reorder") {
					lines.push(`var page = await figma.getNodeByIdAsync(${JSON.stringify(pageId)});`);
					lines.push(`if (!page || page.type !== 'PAGE') throw new Error('Page not found: ${pageId}');`);
					lines.push(`figma.root.insertChild(${index ?? 0}, page);`);
					lines.push(`return { success: true, page: { id: page.id, name: page.name, newIndex: ${index ?? 0} } };`);
				}

				const result = await connector.executeCodeViaUI(lines.join('\n'));
				if (result.error) throw new Error(result.error);

				const r = result.result || {};
				if (action === "list") {
					const pages = r.pages || [];
					const lines2 = pages.map((p: any) => `  ${p.isCurrent ? ">" : " "} ${p.id}  "${p.name}"  [${p.index}]`);
					return ok(`Pages (${pages.length}):\n${lines2.join("\n")}`);
				} else if (action === "delete") {
					return ok(`Page deleted — "${r.deleted}"`);
				} else if (action === "create") {
					return ok(`Page created — "${r.page?.name}"\n  id: ${r.page?.id}`);
				} else if (action === "rename") {
					return ok(`Page renamed — "${r.page?.name}"\n  id: ${r.page?.id}`);
				} else if (action === "switch") {
					const cp = r.currentPage || {};
					return ok(`Switched to page "${cp.name}"\n  id: ${cp.id}`);
				} else {
					const p = r.page || {};
					return ok(`Page reordered — "${p.name}" → index ${p.newIndex}\n  id: ${p.id}`);
				}
			} catch (error) {
				logger.error({ error }, "Failed page operation");
				return err(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// Tool: Set Text Content (with full typography support)
	server.tool(
		"figma_set_text",
		`Set text content and typography on a text node. Supports full font control, alignment, spacing, decoration, and auto-resize.

Font style names: "Regular", "Bold", "Semi Bold", "Light", "Italic", "Bold Italic", etc. — must match an installed font style exactly.`,
		{
			nodeId: z.string().describe("The text node ID"),
			text: z.string().optional().describe("The new text content (omit to keep existing text and only change styling)"),
			fontSize: z.number().optional().describe("Font size in pixels"),
			fontFamily: z.string().optional().describe("Font family name (e.g., 'Inter', 'Roboto'). Must be installed in Figma."),
			fontStyle: z.string().optional().describe("Font style name (e.g., 'Regular', 'Bold', 'Semi Bold', 'Italic', 'Bold Italic')"),
			textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional().describe("Horizontal text alignment"),
			textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional().describe("Vertical text alignment"),
			lineHeight: z.object({
				value: z.number().optional().describe("Line height value (omit for AUTO)"),
				unit: z.enum(["PIXELS", "PERCENT", "AUTO"]).describe("Unit type"),
			}).optional().describe("Line height setting"),
			letterSpacing: z.object({
				value: z.number().describe("Letter spacing value"),
				unit: z.enum(["PIXELS", "PERCENT"]).optional().default("PIXELS").describe("Unit (default: PIXELS)"),
			}).optional().describe("Letter spacing"),
			textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional().describe("How the text node resizes to fit content"),
			textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional().describe("Text decoration"),
			textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional().describe("Text case transformation"),
			textStyleId: z.string().optional().describe("Text style ID to apply (from figma_create_style list). Empty string to detach."),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async ({ nodeId, text, fontSize, fontFamily, fontStyle, textAlignHorizontal, textAlignVertical, lineHeight, letterSpacing, textAutoResize, textDecoration, textCase, textStyleId }) => {
			try {
				const connector = await getDesktopConnector();
				const options: Record<string, any> = {};
				if (fontSize !== undefined) options.fontSize = fontSize;
				if (fontFamily !== undefined) options.fontFamily = fontFamily;
				if (fontStyle !== undefined) options.fontStyle = fontStyle;
				if (textAlignHorizontal !== undefined) options.textAlignHorizontal = textAlignHorizontal;
				if (textAlignVertical !== undefined) options.textAlignVertical = textAlignVertical;
				if (lineHeight !== undefined) options.lineHeight = lineHeight;
				if (letterSpacing !== undefined) options.letterSpacing = letterSpacing;
				if (textAutoResize !== undefined) options.textAutoResize = textAutoResize;
				if (textDecoration !== undefined) options.textDecoration = textDecoration;
				if (textCase !== undefined) options.textCase = textCase;

				const result = await connector.setTextContent(
					nodeId,
					text,
					Object.keys(options).length > 0 ? options : undefined,
				);

				if (!result.success) {
					throw new Error(result.error || "Failed to set text");
				}

				if (textStyleId !== undefined) {
					const styleResult = await connector.executeCodeViaUI(
						`var node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
						if (!node || node.type !== 'TEXT') throw new Error('Text node not found');
						await node.setTextStyleIdAsync(${JSON.stringify(textStyleId)});
						return { success: true };`
					);
					if (styleResult.error) throw new Error(styleResult.error);
				}

				const stylePart = textStyleId !== undefined ? (textStyleId === "" ? " (style detached)" : " + style applied") : "";
				const nodeLine = fmtNode(result.node);
				return ok(`Text updated${stylePart}${nodeLine ? `\n  ${nodeLine}` : ""}`);
			} catch (error) {
				logger.error({ error }, "Failed to set text content");
				return err(
					error instanceof Error ? error.message : String(error),
					"Make sure the node is a TEXT node. For font errors, verify the fontFamily + fontStyle combo is installed.",
				);
			}
		},
	);

	// Tool: Create Child Node
	server.tool(
		"figma_create_child",
		"Create a new child node inside a parent container. Useful for adding shapes, text, or frames to existing structures.",
		{
			parentId: z.string().describe("The parent node ID"),
			nodeType: z
				.enum(["RECTANGLE", "ELLIPSE", "FRAME", "TEXT", "LINE"])
				.describe("Type of node to create"),
			properties: z
				.object({
					name: z.string().optional().describe("Name for the new node"),
					x: z.number().optional().describe("X position within parent"),
					y: z.number().optional().describe("Y position within parent"),
					width: z.number().optional().describe("Width (default: 100)"),
					height: z.number().optional().describe("Height (default: 100)"),
					fills: z
						.array(
							z.object({
								type: z.literal("SOLID"),
								color: z.string(),
							}),
						)
						.optional()
						.describe("Fill colors (hex strings)"),
					text: z
						.string()
						.optional()
						.describe("Text content (for TEXT nodes only)"),
				})
				.optional()
				.describe("Properties for the new node"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async ({ parentId, nodeType, properties }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createChildNode(
					parentId,
					nodeType,
					properties,
				);

				if (!result.success) {
					throw new Error(result.error || "Failed to create node");
				}

				const nodeLine = fmtNode(result.node);
				return ok(`Created ${nodeType}${properties?.name ? ` "${properties.name}"` : ""}${nodeLine ? `\n  ${nodeLine}` : ""}`);
			} catch (error) {
				logger.error({ error }, "Failed to create child node");
				return err(
					error instanceof Error ? error.message : String(error),
					"Make sure the parent node supports children (frames, groups, etc.)",
				);
			}
		},
	);

	// Tool: Set Auto-Layout & Grid properties
	server.tool(
		"figma_set_layout",
		`Set auto-layout (flexbox) or CSS grid properties on a frame, and/or child sizing properties on any node inside an auto-layout/grid parent. Call once on the container, then once per child that needs non-default sizing.

**Container properties** (node must be FRAME, COMPONENT, COMPONENT_SET, or INSTANCE):
- layoutMode, alignment, spacing, padding, wrap, z-order
- Grid: track counts, track sizes, row/column gaps

**Child properties** (any node inside auto-layout/grid parent):
- layoutSizingHorizontal/Vertical (FIXED, HUG, FILL), layoutGrow, layoutPositioning
- Grid child: span, anchor index, alignment

**GRID IMPORTANT:** Setting layoutMode='GRID' only configures the container. Children do NOT auto-place — you MUST explicitly set gridColumnAnchorIndex + gridRowAnchorIndex on each child to position them in the grid. Without anchors, all children stack at cell (0,0). Typical workflow:
1. Set container: layoutMode='GRID', gridColumnCount, gridRowSizes/gridColumnSizes, gap
2. Set each child: gridColumnAnchorIndex, gridRowAnchorIndex (and optionally gridColumnSpan/gridRowSpan)

**ABSOLUTE POSITIONING:** When layoutPositioning='ABSOLUTE', also set constraints to pin edges:
- constraintHorizontal: 'MIN' (left), 'MAX' (right), 'STRETCH' (left+right stretch), 'CENTER', 'SCALE'
- constraintVertical: 'MIN' (top), 'MAX' (bottom), 'STRETCH' (top+bottom stretch), 'CENTER', 'SCALE'

**Shorthands** to save tokens:
- \`padding\` sets all 4 sides; individual paddingTop/Right/Bottom/Left override
- \`gap\` sets both axes (itemSpacing + counterAxisSpacing, or gridColumnGap + gridRowGap in grid mode); individual values override`,
		{
			nodeId: z.string().describe("Target node ID"),
			// Container props
			layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).optional().describe("Layout mode"),
			primaryAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional().describe("Main axis alignment"),
			counterAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional().describe("Cross axis alignment"),
			counterAxisAlignContent: z.enum(["AUTO", "SPACE_BETWEEN"]).optional().describe("Cross axis content distribution (wrap mode)"),
			primaryAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional().describe("Main axis sizing"),
			counterAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional().describe("Cross axis sizing"),
			padding: z.number().optional().describe("Shorthand: set all 4 padding sides"),
			paddingTop: z.number().optional(),
			paddingRight: z.number().optional(),
			paddingBottom: z.number().optional(),
			paddingLeft: z.number().optional(),
			gap: z.number().optional().describe("Shorthand: set itemSpacing + counterAxisSpacing (or grid gaps)"),
			itemSpacing: z.number().optional().describe("Spacing between items on primary axis"),
			counterAxisSpacing: z.number().optional().describe("Spacing between items on counter axis (wrap mode)"),
			layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Wrap mode (only for HORIZONTAL)"),
			itemReverseZIndex: z.boolean().optional().describe("Reverse z-order of children"),
			strokesIncludedInLayout: z.boolean().optional().describe("Include strokes in layout calculations"),
			// Grid container
			gridColumnCount: z.number().int().positive().optional().describe("Number of grid columns"),
			gridRowCount: z.number().int().positive().optional().describe("Number of grid rows"),
			gridColumnSizes: z.array(z.object({ type: z.enum(["FIXED", "FLEX"]), value: z.number() })).optional().describe("Column track sizes"),
			gridRowSizes: z.array(z.object({ type: z.enum(["FIXED", "FLEX"]), value: z.number() })).optional().describe("Row track sizes"),
			gridColumnGap: z.number().optional(),
			gridRowGap: z.number().optional(),
			// Child props
			layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Child horizontal sizing"),
			layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Child vertical sizing"),
			layoutGrow: z.number().optional().describe("Flex grow (0 or 1)"),
			layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional().describe("Auto-layout or absolute positioning"),
			layoutAlign: z.enum(["AUTO", "STRETCH", "INHERIT"]).optional().describe("Cross-axis alignment override (deprecated, prefer layoutSizingHorizontal/Vertical)"),
			minWidth: z.number().nullable().optional().describe("Min width constraint (null to remove)"),
			maxWidth: z.number().nullable().optional().describe("Max width constraint (null to remove)"),
			minHeight: z.number().nullable().optional().describe("Min height constraint (null to remove)"),
			maxHeight: z.number().nullable().optional().describe("Max height constraint (null to remove)"),
			// Constraints (for absolute-positioned children)
			constraintHorizontal: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional()
				.describe("Horizontal constraint (absolute children). MIN=left, MAX=right, STRETCH=left+right stretch"),
			constraintVertical: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional()
				.describe("Vertical constraint (absolute children). MIN=top, MAX=bottom, STRETCH=top+bottom stretch"),
			// Grid child
			gridColumnSpan: z.number().int().positive().optional().describe("Number of columns to span"),
			gridRowSpan: z.number().int().positive().optional().describe("Number of rows to span"),
			gridColumnAnchorIndex: z.number().int().optional().describe("Column anchor index"),
			gridRowAnchorIndex: z.number().int().optional().describe("Row anchor index"),
			gridChildHorizontalAlign: z.enum(["AUTO", "MIN", "CENTER", "MAX"]).optional().describe("Grid child horizontal alignment"),
			gridChildVerticalAlign: z.enum(["AUTO", "MIN", "CENTER", "MAX"]).optional().describe("Grid child vertical alignment"),
			variableBindings: z.array(z.object({
				field: z.enum([
					"paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
					"itemSpacing", "counterAxisSpacing",
				]).describe("Layout property to bind"),
				variableId: z.string().describe("Variable ID. Empty string to unbind."),
			})).optional().describe("Bind variables to layout spacing properties."),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async (params, extra) => {
			try {
				const connector = await getDesktopConnector();
				const { nodeId, ...props } = params;

				const script = `
var nodeId = ${JSON.stringify(nodeId)};
var props = ${JSON.stringify(props)};
var applied = [];
var skipped = [];
var errors = [];

var node = await figma.getNodeByIdAsync(nodeId);
if (!node) return { success: false, error: 'Node not found: ' + nodeId };

function setProp(name, value) {
  try {
    node[name] = value;
    applied.push(name);
  } catch (e) {
    errors.push({ property: name, error: String(e) });
  }
}

// Resolve padding shorthand
if (props.padding !== undefined) {
  if (props.paddingTop === undefined) props.paddingTop = props.padding;
  if (props.paddingRight === undefined) props.paddingRight = props.padding;
  if (props.paddingBottom === undefined) props.paddingBottom = props.padding;
  if (props.paddingLeft === undefined) props.paddingLeft = props.padding;
}

// Resolve gap shorthand — route based on layout mode
if (props.gap !== undefined) {
  var mode = props.layoutMode || node.layoutMode;
  if (mode === 'GRID') {
    if (props.gridColumnGap === undefined) props.gridColumnGap = props.gap;
    if (props.gridRowGap === undefined) props.gridRowGap = props.gap;
  } else {
    if (props.itemSpacing === undefined) props.itemSpacing = props.gap;
    if (props.counterAxisSpacing === undefined) props.counterAxisSpacing = props.gap;
  }
}

// Container properties — must set layoutMode first
var containerProps = [
  'layoutMode',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent',
  'primaryAxisSizingMode', 'counterAxisSizingMode',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'itemSpacing', 'counterAxisSpacing',
  'layoutWrap', 'itemReverseZIndex', 'strokesIncludedInLayout',
  'gridColumnCount', 'gridRowCount',
  'gridColumnSizes', 'gridRowSizes',
  'gridColumnGap', 'gridRowGap'
];

// Child properties (excluding grid anchors — handled specially below)
var childProps = [
  'layoutSizingHorizontal', 'layoutSizingVertical',
  'layoutGrow', 'layoutPositioning', 'layoutAlign',
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'gridColumnSpan', 'gridRowSpan',
  'gridChildHorizontalAlign', 'gridChildVerticalAlign'
];

for (var p of containerProps) {
  if (props[p] !== undefined) setProp(p, props[p]);
}
for (var p of childProps) {
  if (props[p] !== undefined) setProp(p, props[p]);
}

// Grid anchor indices — read-only props, must use setGridChildPosition(row, col)
if (props.gridColumnAnchorIndex !== undefined || props.gridRowAnchorIndex !== undefined) {
  try {
    var row = props.gridRowAnchorIndex !== undefined ? props.gridRowAnchorIndex : node.gridRowAnchorIndex;
    var col = props.gridColumnAnchorIndex !== undefined ? props.gridColumnAnchorIndex : node.gridColumnAnchorIndex;
    node.setGridChildPosition(row, col);
    if (props.gridColumnAnchorIndex !== undefined) applied.push('gridColumnAnchorIndex');
    if (props.gridRowAnchorIndex !== undefined) applied.push('gridRowAnchorIndex');
  } catch (e) {
    errors.push({ property: 'gridAnchor', error: String(e), hint: 'Parent must have layoutMode=GRID. Indices are 0-based and must be within grid bounds. Position must not overlap another child.' });
  }
}

// Constraints — compound property, must merge with existing
if (props.constraintHorizontal !== undefined || props.constraintVertical !== undefined) {
  try {
    var existing = node.constraints || { horizontal: 'MIN', vertical: 'MIN' };
    node.constraints = {
      horizontal: props.constraintHorizontal || existing.horizontal,
      vertical: props.constraintVertical || existing.vertical
    };
    if (props.constraintHorizontal) applied.push('constraintHorizontal');
    if (props.constraintVertical) applied.push('constraintVertical');
  } catch (e) {
    errors.push({ property: 'constraints', error: String(e) });
  }
}

if (props.variableBindings) {
  for (var b of props.variableBindings) {
    try {
      if (b.variableId === "") {
        node.setBoundVariable(b.field, null);
      } else {
        var v = await figma.variables.getVariableByIdAsync(b.variableId);
        node.setBoundVariable(b.field, v);
      }
      applied.push('bind:' + b.field);
    } catch (e) {
      errors.push({ property: 'bind:' + b.field, error: String(e) });
    }
  }
}

return {
  success: errors.length === 0,
  nodeId: node.id,
  nodeName: node.name,
  nodeType: node.type,
  layoutMode: node.layoutMode || 'NONE',
  applied: applied,
  errors: errors.length > 0 ? errors : undefined
};`;

				const result = await connector.executeCodeViaUI(script, 10000);

				if (result.error) {
					return err(result.error);
				}

				const r = result.result ?? result;
				const applied = r.applied || [];
				const errors = r.errors || [];
				const heading = errors.length > 0
					? `Layout partially applied on "${r.nodeName}" (${r.nodeType}, ${r.layoutMode})`
					: `Layout updated on "${r.nodeName}" (${r.nodeType}, ${r.layoutMode})`;

				const lines2: string[] = [];
				if (applied.length) lines2.push(`  applied: ${applied.join(", ")}`);
				if (errors.length) {
					for (const e of errors) {
						lines2.push(`  error: ${e.property} — ${e.error}${e.hint ? ` (${e.hint})` : ""}`);
					}
				}

				// Contextual hints
				if (params.layoutPositioning === "ABSOLUTE" && !params.constraintHorizontal && !params.constraintVertical) {
					lines2.push("  hint: Set constraintHorizontal/constraintVertical to pin edges (e.g. STRETCH for left+right stretch)");
				}

				const text = lines2.length ? `${heading}\n${lines2.join("\n")}` : heading;
				if (errors.length > 0) {
					return { content: [{ type: "text" as const, text }], isError: true as const };
				}
				return ok(text);
			} catch (error) {
				return err(error instanceof Error ? error.message : String(error));
			}
		},
	);
}
