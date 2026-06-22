import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { getDefaultEditor, shouldSkipEditor } from "../config.js";
import {
    isWorktreeClean,
    isMainRepoBare,
    getWorktrees,
    stashChanges,
    applyAndDropStash,
    getUpstreamRemote,
} from "../utils/git.js";
import { resolveWorktreePath, validateBranchName } from "../utils/paths.js";
import { AtomicWorktreeOperation } from "../utils/atomic.js";
import { handleDirtyState, confirm } from "../utils/tui.js";
import { onShutdown } from "../utils/shutdown.js";
import { openInHerdr } from "../utils/herdr.js";
import { openWorktreeHandler } from "./open.js";

export async function newWorktreeHandler(
    branchName?: string,
    options: { path?: string; checkout?: boolean; install?: string; editor?: string; stash?: boolean } = {}
) {
    let stashHash: string | null = null;
    let unregisterShutdown: (() => void) | null = null;

    try {
        // 1. Validate we're in a git repo
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);

        // Validate branch name is provided
        if (!branchName || branchName.trim() === "") {
            console.error(chalk.red("Error: Branch name is required."));
            console.error(chalk.yellow("Usage: wt new <branchName> [options]"));
            console.error(chalk.cyan("Example: wt new feature/my-feature --checkout"));
            process.exit(1);
        }

        // Validate branch name format
        const validation = validateBranchName(branchName);
        if (!validation.isValid) {
            console.error(chalk.red(`Error: ${validation.error}`));
            process.exit(1);
        }

        // 2. Check if this is a bare repository (Improvement #2)
        const isBare = await isMainRepoBare();

        // 3. Resolve the target path up front so we can detect whether this
        // worktree already exists (Improvement #1 & #7).
        const resolvedPath = await resolveWorktreePath(branchName, {
            customPath: options.path,
            useRepoNamespace: true,  // Prevent global path collisions
        });

        let directoryExists = false;
        try {
            await stat(resolvedPath);
            directoryExists = true;
        } catch {
            // Directory doesn't exist, continue with creation
        }

        // If the worktree already exists, this is really an "open", not a
        // "new": delegate to `wt open` so the reuse/focus logic lives in a
        // single place instead of being duplicated here.
        if (directoryExists) {
            console.log(chalk.yellow(`Worktree already exists at: ${resolvedPath}`));
            await openWorktreeHandler(resolvedPath, { editor: options.editor });
            return;
        }

        // --- From here on we are creating a brand new worktree ---

        // 4. Check if main worktree is clean (skip for bare repos)
        if (!isBare) {
            console.log(chalk.blue("Checking if main worktree is clean..."));
            const isClean = await isWorktreeClean(".");

            if (!isClean) {
                // Improvement #5: Handle dirty states gracefully
                const action = await handleDirtyState(
                    "Your main worktree has uncommitted changes."
                );

                if (action === 'abort') {
                    console.log(chalk.yellow("Operation cancelled."));
                    process.exit(0);
                } else if (action === 'stash') {
                    console.log(chalk.blue("Stashing your changes..."));
                    stashHash = await stashChanges(".", `wt-new: Before creating worktree for ${branchName}`);
                    if (stashHash) {
                        console.log(chalk.green("Changes stashed successfully."));
                        // Register SIGINT handler to restore stash if interrupted
                        unregisterShutdown = onShutdown(async () => {
                            if (stashHash) {
                                console.log(chalk.blue("Restoring stashed changes due to interruption..."));
                                await applyAndDropStash(stashHash, ".");
                            }
                        });
                    }
                } else {
                    // 'continue' - just warn and proceed
                    console.log(chalk.yellow("Proceeding with uncommitted changes..."));
                }
            } else {
                console.log(chalk.green("Main worktree is clean."));
            }
        }

        // 5. Check if branch exists
        const remote = await getUpstreamRemote();
        const { stdout: localBranches } = await execa("git", ["branch", "--list", branchName]);
        const { stdout: remoteBranches } = await execa("git", ["branch", "-r", "--list", `${remote}/${branchName}`]);
        const branchExists = !!localBranches || !!remoteBranches;

        // 6. Create the new worktree (Improvement #9: atomic with rollback)
        console.log(chalk.blue(`Creating new worktree for branch "${branchName}" at: ${resolvedPath}`));

        const atomic = new AtomicWorktreeOperation();

        try {
            if (!branchExists) {
                console.log(chalk.yellow(`Branch "${branchName}" doesn't exist. Creating new branch with worktree...`));
                await atomic.createWorktree(resolvedPath, branchName, true);
            } else {
                console.log(chalk.green(`Using existing branch "${branchName}".`));
                await atomic.createWorktree(resolvedPath, branchName, false);
            }

            // Run install if specified
            if (options.install) {
                await atomic.runInstall(options.install, resolvedPath);
            }

            // Commit the atomic operation
            atomic.commit();
        } catch (error: any) {
            console.error(chalk.red("Failed to create worktree:"), error.message);
            await atomic.rollback();
            throw error;
        }

        // 7. Register/focus the worktree in herdr's sidebar (best-effort,
        // no-op without herdr).
        await openInHerdr(resolvedPath);

        // 8. Open in the specified editor (or use configured default)
        const configuredEditor = getDefaultEditor();
        const editorCommand = options.editor || configuredEditor;

        if (shouldSkipEditor(editorCommand)) {
            console.log(chalk.gray(`Editor set to 'none', skipping editor open.`));
        } else {
            console.log(chalk.blue(`Opening ${resolvedPath} in ${editorCommand}...`));
            try {
                await execa(editorCommand, [resolvedPath], { stdio: "inherit" });
            } catch (editorError) {
                console.error(chalk.red(`Failed to open editor "${editorCommand}". Please ensure it's installed and in your PATH.`));
                console.warn(chalk.yellow(`Continuing without opening editor.`));
            }
        }

        console.log(chalk.green(`Worktree created at ${resolvedPath}.`));
        if (options.install) {
            console.log(chalk.green(`Dependencies installed using ${options.install}.`));
        }

    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to create new worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to create new worktree:"), error);
        }
        process.exit(1);
    } finally {
        // Unregister shutdown handler
        if (unregisterShutdown) {
            unregisterShutdown();
        }

        // Restore stashed changes if we stashed them
        if (stashHash) {
            console.log(chalk.blue("Restoring your stashed changes..."));
            const restored = await applyAndDropStash(stashHash, ".");
            if (restored) {
                console.log(chalk.green("Changes restored successfully."));
            }
        }
    }
}
