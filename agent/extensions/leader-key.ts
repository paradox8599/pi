/**
 * Leader Key Extension for pi
 *
 * Adds vim-style leader key support: press a configurable leader key
 * (e.g. ctrl+x), then another key to trigger an action.
 *
 * Compatible with alps-pi: wraps the existing editor (including alps-pi's
 * beautified editor) instead of replacing it, so both extensions coexist.
 *
 * Usage:
 *   1. Place this file in ~/.pi/agent/extensions/
 *   2. Restart pi or run /reload
 *   3. Press the leader key, then a follow-up key
 *
 * Configuration:
 *   Edit the CONFIG object below to customize:
 *   - leader: the leader key (default: ctrl+x)
 *   - timeout: ms before leader mode auto-cancels (default: 1500)
 *   - mappings: leader+key → action
 *
 * Action types:
 *   "command" - slash command (e.g. "/new", "/model")
 *   "handler" - direct editor/app action
 */

import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";

// ============================================================
// CONFIGURATION — edit this to customize your leader key setup
// ============================================================

interface LeaderKeyConfig {
	/** The leader key (e.g. "ctrl+space", "ctrl+b", "alt+x") */
	leader: string;
	/** Timeout in ms before leader mode auto-cancels */
	timeout: number;
	/** Leader+key → action mappings.  Prefixed with `/` = slash command; otherwise = keybinding id. */
	mappings: Record<string, string>;
	/** Direct key → action mappings (no leader needed). Same format as mappings. */
	shortcuts: Record<string, string>;
}

const CONFIG: LeaderKeyConfig = {
	leader: "ctrl+x",
	timeout: 1500,
	mappings: {
		// slash commands
		n: "/new",
		l: "/resume",
		t: "/tree",
		f: "/fork",
		m: "/model",
		s: "/scoped-models",
		c: "/compact",
		e: "/reload",
		// editor / app keybindings
		x: "app.clear",
		q: "app.exit",
		i: "app.interrupt",
		v: "app.clipboard.pasteImage",
		g: "app.editor.external",
		o: "app.tools.expand",
		p: "app.model.cycleForward",
		P: "app.model.cycleBackward",

		u: "/rewind",
	},
	shortcuts: {
		"alt+r": "/sandbox-enable",
		"alt+e": "/sandbox-disable",
	},
};

// ============================================================
// IMPLEMENTATION
// ============================================================

const INSTALLED = Symbol("leader-key-installed");

export default function (pi: ExtensionAPI) {
	// Use resources_discover: fires after session_start (so alps-pi has
	// already installed its editor factory) but before Pi renders the TUI
	// (so our wrapper is in place before the editor instance is created).
	pi.on("resources_discover", (_event, ctx) => {
		wrapActiveEditor(ctx);
	});

	// Session start fallback for session-replacement flows (/new, /resume,
	// /fork) where alps-pi's session_start fires first but Pi then renders
	// the TUI from the saved factory.  Defer with setTimeout to let alps-pi
	// install its new factory, then wrap it.
	pi.on("session_start", (_event, ctx) => {
		// Small delay to let alps-pi's session_start handler run first.
		// On /reload and session replacement, alps-pi resets its runtime
		// and calls setEditorComponent synchronously.
		setTimeout(() => wrapActiveEditor(ctx), 0);
	});
}

// ── Wrap current editor factory ──

function wrapActiveEditor(ctx: any): void {
	if (!ctx?.hasUI) return;

	const existingFactory = ctx.ui.getEditorComponent();
	if (!existingFactory) {
		// No custom editor: install our standalone editor with leader key
		ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
			const ed = new LeaderKeyStandaloneEditor(tui, theme, keybindings, ctx);
			installLeaderKey(ed, tui, ctx);
			return ed;
		});
		return;
	}

	// Don't re-wrap if we already own the factory
	if ((existingFactory as any)[INSTALLED]) return;

	// Wrap the existing factory with leader key support
	ctx.ui.setEditorComponent(createWrappedFactory(existingFactory, ctx));
}

function createWrappedFactory(
	innerFactory: (tui: any, theme: any, keybindings: any) => any,
	ctx: any,
): (tui: any, theme: any, keybindings: any) => any {
	const wrapped = (tui: any, theme: any, keybindings: any) => {
		const editor = innerFactory(tui, theme, keybindings);
		installLeaderKey(editor, tui, ctx);
		return editor;
	};
	(wrapped as any)[INSTALLED] = true;
	return wrapped;
}

// ── Standalone editor (used when no custom editor exists) ──

class LeaderKeyStandaloneEditor extends CustomEditor {
	constructor(tui: any, theme: any, keybindings: any, ctx: any) {
		super(tui, theme, keybindings);
	}
}

// ── Leader key patch (applied to any editor instance) ──

interface LeaderKeyState {
	waitingForLeader: boolean;
	leaderTimer: ReturnType<typeof setTimeout> | null;
}

function installLeaderKey(editor: any, tui: any, ctx: any): void {
	if (editor.__leaderKeyInstalled) return;
	editor.__leaderKeyInstalled = true;

	const state: LeaderKeyState = {
		waitingForLeader: false,
		leaderTimer: null,
	};

	const clearTimer = () => {
		if (state.leaderTimer) {
			clearTimeout(state.leaderTimer);
			state.leaderTimer = null;
		}
	};

	const startTimer = () => {
		clearTimer();
		state.leaderTimer = setTimeout(() => {
			state.waitingForLeader = false;
			updateStatus();
			tui.requestRender?.();
		}, CONFIG.timeout);
	};

	const updateStatus = () => {
		try {
			ctx.ui.setStatus(
				"leader",
				state.waitingForLeader
					? (ctx.ui.theme?.fg?.("accent", "LEADER") ?? "LEADER")
					: undefined,
			);
		} catch {
			// setStatus may throw on stale ctx; ignore
		}
		tui.requestRender?.();
	};

	// ── Handle input ──

	const origHandleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data: string) => {
		// ── Leader mode: waiting for second key ──
		if (state.waitingForLeader) {
			clearTimer();
			state.waitingForLeader = false;
			updateStatus();

			// Double-tap leader key → pass through as normal key
			if (matchesKey(data, CONFIG.leader)) {
				origHandleInput(data);
				return;
			}

			// Try raw data first, then decoded (for Kitty protocol terminals)
			const decoded = decodeKittyPrintable(data) ?? data;
			const action = CONFIG.mappings[data] ?? CONFIG.mappings[decoded];
			if (action != null) {
				executeAction(action, editor, ctx);
			}
			// Unknown second key → silently ignore (don't pass through)
			return;
		}

		// ── Direct shortcut (no leader) ──
		for (const [key, action] of Object.entries(CONFIG.shortcuts)) {
			if (matchesKey(data, key)) {
				executeAction(action, editor, ctx);
				return;
			}
		}

		// ── Detect leader key press ──
		if (matchesKey(data, CONFIG.leader)) {
			state.waitingForLeader = true;
			updateStatus();
			startTimer();
			return;
		}

		// ── Normal typing ──
		origHandleInput(data);
	};

	// ── Render (add LEADER indicator) ──

	const origRender = editor.render.bind(editor);
	editor.render = (width: number): string[] => {
		const lines = origRender(width);
		if (state.waitingForLeader && lines.length > 0) {
			const indicator = " LEADER ";
			const last = lines.length - 1;
			const maxBorder = width - indicator.length;
			if (maxBorder > 0) {
				lines[last] = truncateToWidth(lines[last]!, maxBorder, "") + indicator;
			}
		}
		return lines;
	};
}

// ── Action dispatch ──

function executeAction(action: string, editor: any, ctx: any): void {
	if (action.startsWith("/")) {
		// Slash command: submit it through the editor
		editor.onSubmit?.(action);
	} else {
		executeHandler(action, editor, ctx);
	}
}

/**
 * Handler dispatch — handler names are full keybinding IDs from
 * keybindings.json.  Tries actionHandlers, falls back to editor hooks.
 */
function executeHandler(handler: string, editor: any, ctx: any): void {
	// 1. Registered action handler (app.* bindings)
	const fn = editor.actionHandlers?.get(handler as any);
	if (fn) {
		fn();
		return;
	}

	// 2. Editor hooks (bypass actionHandlers)
	if (handler === "app.clear") {
		editor.setText?.("");
		return;
	}
	if (handler === "app.exit") {
		editor.onCtrlD?.();
		return;
	}
	if (handler === "app.interrupt") {
		editor.onEscape?.();
		return;
	}
	if (handler === "app.clipboard.pasteImage") {
		editor.onPasteImage?.();
		return;
	}
	if (handler === "app.tools.expand") {
		ctx.ui.setToolsExpanded?.(!ctx.ui.getToolsExpanded?.());
		return;
	}

	// 3. TUI editor internals — call private methods by name
	const ed = editor as Record<string, any>;
	if (handler === "tui.editor.undo") {
		ed.undo?.();
		return;
	}
	if (handler === "tui.editor.yank") {
		ed.yank?.();
		return;
	}
	if (handler === "tui.editor.yankPop") {
		ed.yankPop?.();
		return;
	}
}
