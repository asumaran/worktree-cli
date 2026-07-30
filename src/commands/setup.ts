import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { getMainRepoRoot, getRepoRoot, getWorktrees } from "../utils/git.js";
import { resolveWorktreePath, validateBranchName } from "../utils/paths.js";
import { loadSetupCommands, executeSetupCommands } from "../utils/setup.js";
import { confirmCommands } from "../utils/tui.js";

/**
 * (Re)provision existing worktrees: run the setup scripts from worktrees.json
 * or .cursor/worktrees.json inside worktrees that already exist.
 *
 * This command does NOT create worktrees — `wt new` does that (and runs the
 * setup scripts on creation). Use `wt setup` to re-apply the scripts after
 * they change, or to backfill worktrees created before the scripts existed.
 *
 * Target resolution:
 * - `wt setup <branch>`: the worktree for that branch.
 * - `wt setup` from inside a linked worktree: that worktree.
 * - `wt setup --all`: every linked worktree of the repository.
 */
export async function setupWorktreeHandler(
    branchName?: string,
    options: { path?: string; all?: boolean; trust?: boolean } = {}
) {
    try {
        // 1. Validate we're in a git repo
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);

        // 2. Resolve the main checkout root; the setup file lives there and
        // $ROOT_WORKTREE_PATH must point at it.
        const mainRoot = await getMainRepoRoot();
        if (!mainRoot) {
            console.error(chalk.red("Could not determine the main repository root."));
            process.exit(1);
        }

        const setup = await loadSetupCommands(mainRoot);
        if (!setup) {
            console.error(chalk.yellow("No setup file found (.cursor/worktrees.json or worktrees.json)."));
            console.log(chalk.yellow("Tip: Create a worktrees.json file in the main checkout to automate setup commands."));
            process.exit(1);
        }

        // 3. Resolve target worktrees
        let targets: string[] = [];

        if (options.all) {
            const worktrees = await getWorktrees(mainRoot);
            targets = worktrees
                .filter((w) => !w.isMain && !w.prunable && !w.bare)
                .map((w) => w.path);

            if (targets.length === 0) {
                console.log(chalk.yellow("No linked worktrees found for this repository."));
                return;
            }
        } else if (branchName) {
            const validation = validateBranchName(branchName);
            if (!validation.isValid) {
                console.error(chalk.red(`Error: ${validation.error}`));
                process.exit(1);
            }

            const resolvedPath = await resolveWorktreePath(branchName, {
                customPath: options.path,
                cwd: mainRoot,
                useRepoNamespace: true,
            });

            try {
                await stat(resolvedPath);
            } catch {
                console.error(chalk.red(`Worktree does not exist at: ${resolvedPath}`));
                console.log(chalk.yellow(`Create it first with: wt new ${branchName}`));
                process.exit(1);
            }

            targets = [resolvedPath];
        } else {
            // No branch given: target the current worktree, if we're inside one.
            const cwdRoot = await getRepoRoot();
            if (cwdRoot && cwdRoot !== mainRoot) {
                targets = [cwdRoot];
            } else {
                console.error(chalk.red("You are in the main checkout. Pass a branch name, use --all, or run this from inside a worktree."));
                process.exit(1);
            }
        }

        // 4. Confirm once, then run in every target
        console.log(chalk.blue(`Found setup file: ${setup.filePath}`));
        const shouldRun = await confirmCommands(setup.commands, {
            title: `The following setup commands will run in ${targets.length} worktree${targets.length === 1 ? "" : "s"}:`,
            trust: options.trust,
        });

        if (!shouldRun) {
            console.log(chalk.yellow("Setup commands skipped."));
            return;
        }

        for (const target of targets) {
            console.log(chalk.blue(`Running setup in: ${target}`));
            await executeSetupCommands(setup.commands, target, mainRoot);
        }
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to run setup scripts:"), error.message);
        } else {
            console.error(chalk.red("Failed to run setup scripts:"), error);
        }
        process.exit(1);
    }
}
