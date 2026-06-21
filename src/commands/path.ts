import chalk from "chalk";
import { execa } from "execa";
import { resolveWorktreePath, validateBranchName } from "../utils/paths.js";

/**
 * Print the absolute worktree path for a branch WITHOUT creating anything.
 *
 * This exposes the same path resolution used by `wt new` (config
 * `defaultWorktreePath` + repo namespace + branch sanitization) so external
 * tools can agree on where a branch's worktree lives. The resolved path is the
 * only thing written to stdout, so callers can capture it directly; all
 * diagnostics go to stderr.
 *
 * @param branchName - Branch to resolve the worktree path for
 * @param options.cwd - Directory used to locate the repository (defaults to cwd)
 */
export async function pathWorktreeHandler(
    branchName?: string,
    options: { cwd?: string } = {}
) {
    try {
        const cwd = options.cwd || process.cwd();

        // Validate we're in a git repo (resolve from the given cwd)
        await execa("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);

        if (!branchName || branchName.trim() === "") {
            console.error(chalk.red("Error: Branch name is required."));
            console.error(chalk.yellow("Usage: wt path <branchName>"));
            process.exit(1);
        }

        const validation = validateBranchName(branchName);
        if (!validation.isValid) {
            console.error(chalk.red(`Error: ${validation.error}`));
            process.exit(1);
        }

        const resolvedPath = await resolveWorktreePath(branchName, {
            cwd,
            useRepoNamespace: true,
        });

        // Print ONLY the path to stdout so other tools can capture it cleanly.
        console.log(resolvedPath);
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to resolve worktree path:"), error.message);
        } else {
            console.error(chalk.red("Failed to resolve worktree path:"), error);
        }
        process.exit(1);
    }
}
