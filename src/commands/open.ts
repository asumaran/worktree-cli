import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getDefaultEditor, shouldSkipEditor } from "../config.js";
import { findWorktreeByBranch, findWorktreeByPath, findWorktreeByFolderName, localBranchExists, WorktreeInfo } from "../utils/git.js";
import { selectWorktree } from "../utils/tui.js";
import { openInHerdr } from "../utils/herdr.js";
import { parsePrReference, PrReference, resolveProvider, getBranchNameFromPR, assertUrlMatchesRepo } from "../utils/pr.js";

/**
 * Minimal WorktreeInfo for a directory that is a git worktree but not listed by
 * `git worktree list` (rare; e.g. a detached checkout outside the current repo).
 */
function minimalWorktreeInfo(path: string): WorktreeInfo {
    return {
        path,
        head: '',
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
        isMain: false,
        bare: false,
    };
}

/**
 * Resolve an argument against the local repository, trying (in order):
 * an existing directory path, an exact branch name, then a worktree folder name.
 *
 * Returns null when nothing local matches. Throws when the argument names an
 * existing directory that is not a git worktree.
 */
async function resolveLocalTarget(arg: string): Promise<WorktreeInfo | null> {
    // 1. Existing path (directory)
    let stats: Awaited<ReturnType<typeof stat>> | null = null;
    try {
        stats = await stat(arg);
    } catch {
        // Not a filesystem path; fall through to branch/folder lookups.
    }

    if (stats?.isDirectory()) {
        const byPath = await findWorktreeByPath(arg);
        if (byPath) return byPath;

        // A directory that isn't a registered worktree: still openable if it's
        // a git worktree on its own.
        try {
            await stat(resolve(arg, ".git"));
            return minimalWorktreeInfo(resolve(arg));
        } catch {
            throw new Error(`The path "${arg}" exists but is not a git worktree.`);
        }
    }

    // 2. Branch name (exact)
    const byBranch = await findWorktreeByBranch(arg);
    if (byBranch) return byBranch;

    // 3. Worktree folder name (basename)
    const byFolder = await findWorktreeByFolderName(arg);
    if (byFolder) return byFolder;

    return null;
}

/**
 * Resolve a PR/MR reference to an existing worktree in the current repository.
 *
 * For URL references, validates that the URL points at the current repository
 * before making any network/CLI call. `wt open` never creates worktrees, so if
 * no worktree exists for the PR's branch this throws with a hint to `wt pr`.
 */
async function resolvePrTarget(prRef: PrReference): Promise<WorktreeInfo> {
    if (prRef.url) {
        await assertUrlMatchesRepo(prRef.url);
    }

    const provider = await resolveProvider();
    const requestType = provider === 'gh' ? 'PR' : 'MR';

    const branchName = await getBranchNameFromPR(prRef.number, provider);

    const worktree = await findWorktreeByBranch(branchName);
    if (!worktree) {
        throw new Error(
            `Found ${requestType} #${prRef.number} (branch "${branchName}"), but no worktree exists for it yet.\n` +
            `Create it with: wt pr ${prRef.number}`
        );
    }
    return worktree;
}

export async function openWorktreeHandler(
    pathOrBranch: string = "",
    options: { editor?: string }
) {
    try {
        // 1. Validate we're in a git repo
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);

        let targetWorktree: WorktreeInfo | null = null;

        // Improvement #4: Interactive TUI for missing arguments
        if (!pathOrBranch) {
            const selected = await selectWorktree({
                message: "Select a worktree to open",
                excludeMain: false,
            });

            if (!selected || Array.isArray(selected)) {
                console.log(chalk.yellow("No worktree selected."));
                process.exit(0);
            }

            targetWorktree = selected;
        } else {
            // Resolution order:
            //   1. Explicit PR/MR reference (`#123` or a PR/MR URL)
            //   2. Existing directory path
            //   3. Exact branch name
            //   4. Worktree folder name (basename)
            //   5. Bare number (`123`) resolved as a PR/MR (fallback, after
            //      local lookups fail so a real branch/folder named "123" wins)
            const prRef = parsePrReference(pathOrBranch);

            if (prRef?.explicit) {
                targetWorktree = await resolvePrTarget(prRef);
            } else {
                targetWorktree = await resolveLocalTarget(pathOrBranch);

                if (!targetWorktree && prRef) {
                    targetWorktree = await resolvePrTarget(prRef);
                }
            }

            if (!targetWorktree) {
                // If the argument names an existing local branch that simply
                // has no worktree yet, point the user at `wt new` instead of the
                // generic "not found" message.
                if (await localBranchExists(pathOrBranch)) {
                    console.error(chalk.red(`Branch "${pathOrBranch}" exists but has no worktree yet.`));
                    console.error(chalk.yellow(`Create one with: wt new ${pathOrBranch}`));
                } else {
                    console.error(chalk.red(`Could not find a worktree matching "${pathOrBranch}".`));
                    console.error(chalk.yellow("Use 'wt list' to see existing worktrees, or run 'wt open' without arguments to select interactively."));
                }
                process.exit(1);
            }
        }

        const targetPath = targetWorktree.path;

        // Verify the target path exists
        try {
            await stat(targetPath);
        } catch {
            console.error(chalk.red(`The worktree path "${targetPath}" no longer exists.`));
            console.error(chalk.yellow("The worktree may have been removed. Run 'git worktree prune' to clean up."));
            process.exit(1);
        }

        // Display worktree info
        if (targetWorktree.branch) {
            console.log(chalk.blue(`Opening worktree for branch "${targetWorktree.branch}"...`));
        } else if (targetWorktree.detached) {
            console.log(chalk.blue(`Opening detached worktree at ${targetWorktree.head.substring(0, 7)}...`));
        } else {
            console.log(chalk.blue(`Opening worktree at ${targetPath}...`));
        }

        // Show status indicators
        if (targetWorktree.locked) {
            console.log(chalk.yellow(`Note: This worktree is locked${targetWorktree.lockReason ? `: ${targetWorktree.lockReason}` : ''}`));
        }
        if (targetWorktree.prunable) {
            console.log(chalk.yellow(`Warning: This worktree is marked as prunable${targetWorktree.pruneReason ? `: ${targetWorktree.pruneReason}` : ''}`));
        }

        // Register/focus the worktree in herdr's sidebar (best-effort, no-op
        // without herdr). Mirrors `wt new` so reopening keeps the sidebar in sync.
        await openInHerdr(targetPath);

        // Open in the specified editor (or use configured default)
        const configuredEditor = getDefaultEditor();
        const editorCommand = options.editor || configuredEditor;

        if (shouldSkipEditor(editorCommand)) {
            console.log(chalk.gray(`Editor set to 'none', skipping editor open.`));
            console.log(chalk.green(`Worktree path: ${targetPath}`));
        } else {
            console.log(chalk.blue(`Opening ${targetPath} in ${editorCommand}...`));

            try {
                await execa(editorCommand, [targetPath], { stdio: "inherit" });
                console.log(chalk.green(`Successfully opened worktree in ${editorCommand}.`));
            } catch (editorError) {
                console.error(chalk.red(`Failed to open editor "${editorCommand}". Please ensure it's installed and in your PATH.`));
                process.exit(1);
            }
        }
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to open worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to open worktree:"), error);
        }
        process.exit(1);
    }
}
