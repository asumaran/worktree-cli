import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { findWorktreeByBranch, findWorktreeByPath, WorktreeInfo } from "../utils/git.js";
import { selectWorktree } from "../utils/tui.js";

export async function cdWorktreeHandler(pathOrBranch: string = "") {
    try {
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);

        let targetWorktree: WorktreeInfo | null = null;

        if (!pathOrBranch) {
            const selected = await selectWorktree({
                message: "Select a worktree to navigate to",
                excludeMain: false,
            });

            if (!selected || Array.isArray(selected)) {
                console.error(chalk.yellow("No worktree selected."));
                process.exit(0);
            }

            targetWorktree = selected;
        } else {
            // Try to find by path first
            try {
                const stats = await stat(pathOrBranch);
                if (stats.isDirectory()) {
                    targetWorktree = await findWorktreeByPath(pathOrBranch);
                    if (!targetWorktree) {
                        try {
                            await stat(resolve(pathOrBranch, ".git"));
                            targetWorktree = {
                                path: resolve(pathOrBranch),
                                head: '',
                                branch: null,
                                detached: false,
                                locked: false,
                                prunable: false,
                                isMain: false,
                                bare: false,
                            };
                        } catch {
                            console.error(chalk.red(`The path "${pathOrBranch}" exists but is not a git worktree.`));
                            process.exit(1);
                        }
                    }
                }
            } catch {
                // Not a valid path, try as branch name
            }

            if (!targetWorktree) {
                targetWorktree = await findWorktreeByBranch(pathOrBranch);
                if (!targetWorktree) {
                    console.error(chalk.red(`Could not find a worktree for branch "${pathOrBranch}".`));
                    console.error(chalk.yellow("Use 'wt list' to see existing worktrees, or run 'wt cd' without arguments to select interactively."));
                    process.exit(1);
                }
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

        // Shell-escape the path by wrapping in single quotes
        const escapedPath = "'" + targetPath.replace(/'/g, "'\\''") + "'";
        const cdCommand = `cd ${escapedPath}`;

        // Copy cd command to clipboard (cross-platform)
        let clipboardCmd: string;
        let clipboardArgs: string[];
        if (process.platform === "darwin") {
            clipboardCmd = "pbcopy";
            clipboardArgs = [];
        } else if (process.platform === "win32") {
            clipboardCmd = "clip.exe";
            clipboardArgs = [];
        } else {
            clipboardCmd = "xclip";
            clipboardArgs = ["-selection", "clipboard"];
        }

        try {
            await execa(clipboardCmd, clipboardArgs, { input: cdCommand });
            console.log(chalk.green(`Copied to clipboard: ${cdCommand}`));
            const pasteHint = process.platform === "darwin" ? "Cmd+V" : "Ctrl+V";
            console.log(chalk.gray(`Paste with ${pasteHint} and press Enter to navigate.`));
        } catch {
            // Fallback if clipboard command is unavailable
            console.error(chalk.yellow("Clipboard unavailable. Copy and run the command below:"));
            process.stdout.write(cdCommand + "\n");
        }
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to resolve worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to resolve worktree:"), error);
        }
        process.exit(1);
    }
}
