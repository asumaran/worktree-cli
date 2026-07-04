import chalk from "chalk";
import { basename } from "node:path";
import { getWorktrees, getLocalBranches } from "../utils/git.js";

/**
 * Subcommands whose first positional argument gets dynamic value completion,
 * mapped to the kind of candidates each expects. Commands not listed here
 * (`list`, `purge`, `pr`, `config`, `completion`) have no useful dynamic
 * argument, so the shell falls back to its default (files) or nothing.
 */
const ARGUMENT_COMPLETIONS: Record<string, "worktrees" | "worktrees-no-main" | "branches"> = {
    open: "worktrees",
    cd: "worktrees",
    remove: "worktrees-no-main",
    rm: "worktrees-no-main",
    merge: "branches",
    new: "branches",
    setup: "branches",
    path: "branches",
    extract: "branches",
};

/** Every subcommand name the top-level completer offers (including aliases). */
const SUBCOMMANDS = [
    "new",
    "setup",
    "list",
    "ls",
    "remove",
    "rm",
    "merge",
    "purge",
    "pr",
    "open",
    "path",
    "cd",
    "extract",
    "config",
    "completion",
];

const SUPPORTED_SHELLS = ["zsh", "bash", "fish"] as const;
type Shell = (typeof SUPPORTED_SHELLS)[number];

/** A completion candidate: the value to insert plus an optional short hint. */
interface Candidate {
    value: string;
    /** Short description shown next to the value (zsh and fish only). */
    description?: string;
}

/**
 * Compute the candidates for a subcommand's first argument.
 *
 * Never throws: on any failure (not a git repo, git error) it returns an empty
 * list so the shell completion degrades gracefully instead of erroring.
 */
async function candidatesFor(command: string): Promise<Candidate[]> {
    const kind = ARGUMENT_COMPLETIONS[command];
    if (!kind) return [];

    try {
        const worktrees = await getWorktrees();

        if (kind === "branches") {
            // Branch commands insert a branch name. List every local branch and,
            // for the ones that already have a worktree, hint the worktree folder
            // so you can tell them apart from branches with no worktree.
            const branches = await getLocalBranches();
            const dirByBranch = new Map<string, string>();
            for (const wt of worktrees) {
                if (wt.branch) dirByBranch.set(wt.branch, basename(wt.path));
            }
            return dedupeSorted(
                branches.map(value => ({ value, description: dirByBranch.get(value) }))
            );
        }

        // open/cd/remove: one row per worktree. The inserted value is the
        // worktree folder name (`wt open` resolves it), with the branch (and a
        // `(main)` marker) shown as the hint.
        const relevant =
            kind === "worktrees-no-main" ? worktrees.filter(wt => !wt.isMain) : worktrees;

        return dedupeSorted(
            relevant.map(wt => {
                const value = basename(wt.path);
                let description: string | undefined;
                if (wt.branch) {
                    description = wt.isMain ? `${wt.branch} (main)` : wt.branch;
                } else if (wt.detached) {
                    description = wt.isMain ? "detached (main)" : "detached";
                } else if (wt.isMain) {
                    description = "main";
                }
                return { value, description };
            })
        );
    } catch {
        return [];
    }
}

/** Dedupe by value (keeping the first hint) and sort by value. */
function dedupeSorted(candidates: Candidate[]): Candidate[] {
    const byValue = new Map<string, Candidate>();
    for (const candidate of candidates) {
        if (candidate.value && !byValue.has(candidate.value)) {
            byValue.set(candidate.value, candidate);
        }
    }
    return [...byValue.values()].sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Hidden `wt __complete <command> [current]` handler used by the generated
 * shell scripts. Prints one candidate per line to stdout and always exits 0 so
 * a failure can never disrupt the user's shell completion.
 */
export async function completionCandidatesHandler(command: string): Promise<void> {
    const candidates = await candidatesFor(command);
    if (candidates.length > 0) {
        // Emit "value<TAB>description" (or just "value" when there's no hint).
        // zsh turns the tab into its "value:description" list format and fish
        // reads the tabbed description natively; bash keeps only the value.
        const out = candidates
            .map(c => (c.description ? `${c.value}\t${c.description}` : c.value))
            .join("\n");
        process.stdout.write(out + "\n");
    }
    process.exit(0);
}

function zshScript(): string {
    return `#compdef wt

# wt shell completion for zsh.
# Install: wt completion zsh > "\${fpath[1]}/_wt" && exec zsh
# or source it from your ~/.zshrc: source <(wt completion zsh)

_wt() {
  local -a subcommands
  subcommands=(${SUBCOMMANDS.join(" ")})

  if (( CURRENT == 2 )); then
    _describe -t commands 'wt command' subcommands
    return
  fi

  local cmd=\${words[2]}
  case $cmd in
    ${Object.keys(ARGUMENT_COMPLETIONS).join("|")})
      if (( CURRENT == 3 )); then
        local -a candidates
        candidates=(\${(f)"$(wt __complete $cmd 2>/dev/null)"})
        # __complete emits "value<TAB>description"; zsh's _describe wants
        # "value:description", so swap the tab for a colon.
        candidates=(\${candidates//$'\\t'/:})
        _describe -t targets 'target' candidates
      fi
      ;;
  esac
}

# Run when invoked as a completion function, whether sourced or autoloaded.
if [ "\$funcstack[1]" = "_wt" ]; then
  _wt "$@"
else
  compdef _wt wt
fi
`;
}

function bashScript(): string {
    return `# wt shell completion for bash.
# Install: source <(wt completion bash)
# or persist it: wt completion bash > ~/.wt-completion.bash && echo 'source ~/.wt-completion.bash' >> ~/.bashrc

_wt_completions() {
  local cur cmd subcommands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  subcommands="${SUBCOMMANDS.join(" ")}"

  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\$subcommands" -- "\$cur") )
    return
  fi

  cmd="\${COMP_WORDS[1]}"
  case "\$cmd" in
    ${Object.keys(ARGUMENT_COMPLETIONS).join("|")})
      if [ "\$COMP_CWORD" -eq 2 ]; then
        local candidates
        # __complete emits "value<TAB>description"; bash's menu is plain, so
        # keep only the value (first tab-separated field).
        candidates="$(wt __complete "\$cmd" 2>/dev/null | cut -f1)"
        COMPREPLY=( $(compgen -W "\$candidates" -- "\$cur") )
      fi
      ;;
  esac
}

complete -F _wt_completions wt
`;
}

function fishScript(): string {
    const argCommands = Object.keys(ARGUMENT_COMPLETIONS).join(" ");
    return `# wt shell completion for fish.
# Install: wt completion fish > ~/.config/fish/completions/wt.fish

# Subcommands (only when no subcommand has been typed yet).
complete -c wt -f -n '__fish_use_subcommand' -a '${SUBCOMMANDS.join(" ")}'

# Dynamic argument completion for commands that accept a worktree or branch.
# __complete emits "value<TAB>description"; fish shows the tabbed description
# next to each candidate natively.
complete -c wt -f -n '__fish_seen_subcommand_from ${argCommands}' \\
  -a '(wt __complete (commandline -opc)[2] 2>/dev/null)'
`;
}

/**
 * `wt completion <shell>` handler. Prints a completion script for the given
 * shell to stdout so the user can source it or write it into their shell's
 * completion directory.
 */
export async function completionHandler(shell: string): Promise<void> {
    try {
        const normalized = shell.trim().toLowerCase() as Shell;

        if (!SUPPORTED_SHELLS.includes(normalized)) {
            console.error(
                chalk.red(`Unsupported shell "${shell}".`) +
                    ` Supported shells: ${SUPPORTED_SHELLS.join(", ")}.`
            );
            process.exit(1);
        }

        const script =
            normalized === "zsh"
                ? zshScript()
                : normalized === "bash"
                ? bashScript()
                : fishScript();

        process.stdout.write(script);
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to generate completion script:"), error.message);
        } else {
            console.error(chalk.red("Failed to generate completion script:"), error);
        }
        process.exit(1);
    }
}
