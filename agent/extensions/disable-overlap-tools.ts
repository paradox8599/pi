/**
 * Remove overlapping grep/find tools so only pi-fff variants remain.
 *
 * Disabled:
 *   grep, find           (built-in)
 *   hypa_grep, hypa_find (pi-hypa)
 *
 * Kept:
 *   ffgrep, fffind    (pi-fff — frecency, fuzzy, git-aware)
 *   hypa_shell         (pi-hypa — compressed shell output)
 *   hypa_read          (pi-hypa — compressed file reads)
 *   hypa_ls            (pi-hypa — compressed directory listing)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REMOVED = new Set(["grep", "find"]);

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const active: string[] = pi.getActiveTools();
		pi.setActiveTools(active.filter((name: string) => !REMOVED.has(name)));
	});
}
