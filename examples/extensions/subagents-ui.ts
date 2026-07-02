/**
 * subagents-ui.ts — Clean, modern UI customization for pi-subagents
 *
 * Replaces the default braille spinner and rough indicator dots with a
 * polished, minimal animation when subagents are active.
 *
 * Features:
 *   - Beautiful pulsing dot animation (instead of braille spinners) × 3 styles
 *   - Clean status bar with elegant ◈ diamond indicator
 *   - Smooth color transitions using pi theme colors
 *   - Zero configuration needed — auto-detects subagent activity
 *
 * Commands:
 *   /subagents-ui           Show current UI mode
 *   /subagents-ui dot       Clean pulsing dot (default)
 *   /subagents-ui arc       Smooth quarter-circle arc spinner
 *   /subagents-ui minimal   Ultra-minimal single dot
 *   /subagents-ui none      Hide indicator entirely
 *   /subagents-ui reset     Restore pi's default spinner
 *
 * Dependencies:
 *   - @tintinweb/pi-subagents (npm package, for subagents:* events)
 *
 * Installation:
 *   Place in ~/.pi/agent/extensions/ and run /reload in pi.
 */

import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

// ---- Animation style definitions ----

/** Clean pulsing dot — scales from small dot → full circle → back */
function dotFrames(theme: ReturnType<ExtensionContext["ui"]["theme"]>): WorkingIndicatorOptions {
	return {
		frames: [
			theme.fg("dim", "·"),
			theme.fg("muted", "•"),
			theme.fg("accent", "●"),
			theme.fg("muted", "•"),
		],
		intervalMs: 150,
	};
}

/** Smooth quarter-circle arc spinner — cleaner alternative to braille */
function arcFrames(theme: ReturnType<ExtensionContext["ui"]["theme"]>): WorkingIndicatorOptions {
	const accent = (s: string) => theme.fg("accent", s);
	const muted = (s: string) => theme.fg("muted", s);
	return {
		frames: [
			accent("◜"), muted("◠"), muted("◝"),
			muted("◟"), muted("◡"), accent("◞"),
		],
		intervalMs: 100,
	};
}

/** Ultra-minimal single static dot */
function minimalDot(theme: ReturnType<ExtensionContext["ui"]["theme"]>): WorkingIndicatorOptions {
	return {
		frames: [theme.fg("accent", "●")],
	};
}

/** Hidden indicator */
const HIDDEN: WorkingIndicatorOptions = { frames: [] };

// ---- Mode management ----

type UIMode = "dot" | "arc" | "minimal" | "none" | "default";

function getIndicator(
	mode: UIMode,
	theme: ReturnType<ExtensionContext["ui"]["theme"]>,
): WorkingIndicatorOptions | undefined {
	switch (mode) {
		case "dot":
			return dotFrames(theme);
		case "arc":
			return arcFrames(theme);
		case "minimal":
			return minimalDot(theme);
		case "none":
			return HIDDEN;
		case "default":
			return undefined;
	}
}

function describeMode(mode: UIMode): string {
	switch (mode) {
		case "dot":
			return "pulsing dot";
		case "arc":
			return "smooth arc spinner";
		case "minimal":
			return "static dot";
		case "none":
			return "hidden";
		case "default":
			return "pi default";
	}
}

// ---- Extension entry point ----

export default function (pi: ExtensionAPI) {
	let mode: UIMode = "dot";
	let activeCount = 0;
	let lastCtx: ExtensionContext | undefined;

	// Unsubscribe functions for custom event bus listeners
	const unsubs: Array<() => void> = [];

	// ---- Apply the current indicator based on subagent state ----
	function applyIndicator(ctx: ExtensionContext) {
		if (activeCount > 0) {
			// Subagents active → show custom indicator
			ctx.ui.setWorkingIndicator(getIndicator(mode, ctx.ui.theme));
			// Clean status bar: ◈ 3 subagents active
			const dot = ctx.ui.theme.fg("accent", "◈");
			const text = ctx.ui.theme.fg(
				"dim",
				`${activeCount} subagent${activeCount === 1 ? "" : "s"} active`,
			);
			ctx.ui.setStatus("subagents-ui", `${dot} ${text}`);
		} else {
			// No subagents → restore default
			ctx.ui.setWorkingIndicator(undefined);
			ctx.ui.setStatus("subagents-ui", undefined);
		}
	}

	// Capture ctx from pi lifecycle events
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		activeCount = 0;
		applyIndicator(ctx);
	});

	// Also capture ctx from tool execution (session_start might not have full UI)
	pi.on("tool_execution_start", async (_event, ctx) => {
		lastCtx = ctx;
	});

	// ---- Listen to subagent lifecycle events via shared EventBus ----
	// pi-subagents emits these events via pi.events.emit().
	// We subscribe via pi.events.on() which returns an unsubscribe function.

	// Subagent started running
	unsubs.push(
		pi.events.on("subagents:started", () => {
			activeCount++;
			if (lastCtx) applyIndicator(lastCtx);
		}),
	);

	// Subagent completed
	unsubs.push(
		pi.events.on("subagents:completed", () => {
			activeCount = Math.max(0, activeCount - 1);
			if (lastCtx) applyIndicator(lastCtx);
		}),
	);

	// Subagent failed
	unsubs.push(
		pi.events.on("subagents:failed", () => {
			activeCount = Math.max(0, activeCount - 1);
			if (lastCtx) applyIndicator(lastCtx);
		}),
	);

	// Subagent steered (refreshes indicator, count unchanged)
	unsubs.push(
		pi.events.on("subagents:steered", () => {
			if (lastCtx && activeCount > 0) applyIndicator(lastCtx);
		}),
	);

	// Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		activeCount = 0;
		if (lastCtx) {
			lastCtx.ui.setWorkingIndicator(undefined);
			lastCtx.ui.setStatus("subagents-ui", undefined);
		}
		lastCtx = undefined;
		// Unsubscribe all event bus listeners
		for (const unsub of unsubs) unsub();
		unsubs.length = 0;
	});

	// ---- Command: switch UI modes interactively ----
	pi.registerCommand("subagents-ui", {
		description: "Set the subagents UI indicator style: dot, arc, minimal, none, or reset.",
		handler: async (args, ctx) => {
			const nextMode = args.trim().toLowerCase() as UIMode;

			if (!nextMode) {
				ctx.ui.notify(`Subagents UI: ${describeMode(mode)}`, "info");
				return;
			}

			const validModes = ["dot", "arc", "minimal", "none", "reset"];
			if (!validModes.includes(nextMode)) {
				ctx.ui.notify(
					"Usage: /subagents-ui [dot|arc|minimal|none|reset]",
					"error",
				);
				return;
			}

			mode = nextMode === "reset" ? "default" : nextMode;
			lastCtx = ctx;
			applyIndicator(ctx);
			ctx.ui.notify(`Subagents UI: ${describeMode(mode)}`, "info");
		},
	});
}
