import { execa } from "execa";
import chalk from "chalk";
import { dirname } from "node:path";
import { isHerdrIntegrationEnabled } from "../config.js";

/**
 * Resolve the main repository root (the parent worktree).
 *
 * herdr's "open worktree" action must start from the repo's parent workspace,
 * so we pass it as --cwd. `--git-common-dir` points at the shared `.git` of the
 * main worktree even when invoked from a linked worktree, so its parent is the
 * main repo root regardless of where `wt` runs.
 */
async function getMainRepoRoot(): Promise<string | undefined> {
    try {
        const { stdout } = await execa("git", [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ]);
        const commonDir = stdout.trim();
        return commonDir ? dirname(commonDir) : undefined;
    } catch {
        return undefined;
    }
}

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
        const args = ["worktree", "open"];
        // herdr talks to its server over a socket and does not inherit the CLI's
        // cwd, so the repo context must be passed explicitly.
        const repoRoot = await getMainRepoRoot();
        if (repoRoot) {
            args.push("--cwd", repoRoot);
        }
        args.push("--path", worktreePath, "--focus");

        await execa("herdr", args);
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
