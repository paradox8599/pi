/**
 * Leader Key Extension for pi
 *
 * Adds vim-style leader key support: press a configurable leader key
 * (e.g. ctrl+space), then another key to trigger an action.
 *
 * Usage:
 *   1. Place this file in ~/.pi/agent/extensions/
 *   2. Restart pi or run /reload
 *   3. Press the leader key, then a follow-up key
 *
 * Configuration:
 *   Edit the CONFIG object below to customize:
 *   - leader: the leader key (default: ctrl+space)
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

class LeaderKeyEditor extends CustomEditor {
	private pi: ExtensionAPI;
	private ctx: any;
	private config: LeaderKeyConfig;
	private waitingForLeader = false;
	private leaderTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		tui: any,
		theme: any,
		keybindings: any,
		pi: ExtensionAPI,
		ctx: any,
		config?: Partial<LeaderKeyConfig>,
	) {
		super(tui, theme, keybindings);
		this.pi = pi;
		this.ctx = ctx;
		this.config = { ...CONFIG, ...config };
	}

	handleInput(data: string): void {
		// ── Leader mode: waiting for second key ──
		if (this.waitingForLeader) {
			this.clearLeaderTimer();
			this.waitingForLeader = false;
			this.updateLeaderStatus();

			// Double-tap leader key → pass through as normal key
			if (matchesKey(data, this.config.leader)) {
				super.handleInput(data);
				return;
			}

			// Try raw data first, then decoded (for Kitty protocol terminals)
			const decoded = decodeKittyPrintable(data) ?? data;
			const action =
				this.config.mappings[data] ?? this.config.mappings[decoded];
			if (action != null) {
				this.executeAction(action);
			}
			// Unknown second key → silently ignore (don't pass through)
			return;
		}

		// ── Detect leader key press ──
		if (matchesKey(data, this.config.leader)) {
			this.waitingForLeader = true;
			this.updateLeaderStatus();
			this.startLeaderTimer();
			return;
		}

		// ── Direct shortcut (no leader) ──
		for (const [key, action] of Object.entries(this.config.shortcuts)) {
			if (matchesKey(data, key)) {
				this.executeAction(action);
				return;
			}
		}

		// ── Normal typing ──
		super.handleInput(data);
	}

	// ── Action dispatch ──
	// action starting with "/" = slash command, otherwise = keybinding id

	private executeAction(action: string): void {
		if (action.startsWith("/")) {
			this.onSubmit?.(action);
		} else {
			this.executeHandler(action);
		}
	}

	/**
	 * Handler dispatch — handler names are full keybinding IDs from
	 * keybindings.json.  Tries actionHandlers, falls back to editor hooks.
	 */
	private executeHandler(handler: string): void {
		// 1. Registered action handler (app.* bindings)
		const fn = this.actionHandlers.get(handler as any);
		if (fn) {
			fn();
			return;
		}

		// 2. Editor hooks (bypass actionHandlers)
		if (handler === "app.clear") {
			this.setText("");
			return;
		}
		if (handler === "app.exit") {
			this.onCtrlD?.();
			return;
		}
		if (handler === "app.interrupt") {
			this.onEscape?.();
			return;
		}
		if (handler === "app.clipboard.pasteImage") {
			this.onPasteImage?.();
			return;
		}

		// 3. TUI editor internals — call private methods by name
		//    Supported: undo, yank, yankPop
		const ed = this as Record<string, any>;
		if (handler === "tui.editor.undo") {
			ed.undo?.();
			this.tui.requestRender();
			return;
		}
		if (handler === "tui.editor.yank") {
			ed.yank?.();
			this.tui.requestRender();
			return;
		}
		if (handler === "tui.editor.yankPop") {
			ed.yankPop?.();
			this.tui.requestRender();
			return;
		}
	}

	// ── Leader mode timeout ──

	private startLeaderTimer(): void {
		this.clearLeaderTimer();
		this.leaderTimer = setTimeout(() => {
			this.waitingForLeader = false;
			this.updateLeaderStatus();
			this.tui.requestRender();
		}, this.config.timeout);
	}

	private clearLeaderTimer(): void {
		if (this.leaderTimer) {
			clearTimeout(this.leaderTimer);
			this.leaderTimer = null;
		}
	}

	// ── Visual feedback ──

	private updateLeaderStatus(): void {
		if (this.waitingForLeader) {
			this.ctx.ui.setStatus("leader", this.ctx.ui.theme.fg("accent", "LEADER"));
		} else {
			this.ctx.ui.setStatus("leader", undefined);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = super.render(width);
		// Append "LEADER" indicator to editor bottom border when waiting
		if (this.waitingForLeader && lines.length > 0) {
			const indicator = " LEADER ";
			const last = lines.length - 1;
			const maxBorder = width - indicator.length;
			if (maxBorder > 0) {
				lines[last] = truncateToWidth(lines[last]!, maxBorder, "") + indicator;
			}
		}
		return lines;
	}
}

// ============================================================
// EXTENSION ENTRY POINT
// ============================================================

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new LeaderKeyEditor(tui, theme, keybindings, pi, ctx),
		);
	});
}
