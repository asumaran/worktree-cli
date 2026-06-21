import { execa } from "execa";
import chalk from "chalk";
import { isHerdrIntegrationEnabled } from "../config.js";

/**
 * Register a worktree in the herdr sidebar.
 *
 * herdr (https://herdr.dev) is a terminal workspace manager. When its CLI is
 * available, `herdr worktree open` adds the just-created worktree to the
 * sidebar as a workspace with Git provenance and focuses it, so the user lands
 * in the new worktree right away.
 *
 * This is strictly best-effort: it is gated behind the `herdrIntegration`
 * config flag, and any failure (herdr not installed, server not running, etc.)
 * is swallowed so it never blocks or fails `wt new`/`wt setup`.
 *
 * @param worktreePath - Absolute path to the worktree to register
 */
export async function openInHerdr(worktreePath: string): Promise<void> {
    if (!isHerdrIntegrationEnabled()) {
        return;
    }

    try {
        await execa("herdr", ["worktree", "open", "--path", worktreePath, "--focus"]);
    } catch (error: any) {
        // herdr isn't installed at all: stay silent so users without herdr
        // never see noise on every worktree creation.
        if (error?.code === "ENOENT") {
            return;
        }
        // herdr is present but the command failed (e.g. server not running).
        // Surface a quiet hint without failing the worktree creation.
        const detail = error?.shortMessage || error?.message || "unavailable";
        console.warn(chalk.gray(`herdr integration skipped: ${detail}`));
    }
}
