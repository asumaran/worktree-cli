# CLAUDE.md

Guidance for working in this repository.

## What this is

`wt` (`@asumaran/worktree`) is a CLI for managing Git worktrees and opening them
in an editor. It is a fork of `@johnlindquist/worktree` with extra features and
fixes. Distributed as a prebuilt tarball attached to each GitHub Release (no npm
registry); installed globally with `pnpm add -g <release-tarball-url>`.

## Stack & layout

- TypeScript (strict), ESM, Node 16 module resolution. Package manager: **pnpm**.
- CLI framework: `commander`. Output: `chalk`. Subprocesses: `execa`. Config
  store: `conf`. Prompts/TUI: `prompts`, `ora`.
- `src/index.ts` — entry point; registers every command on the `commander`
  program. The `bin` is `wt` → `build/index.js`.
- `src/commands/*.ts` — one file per subcommand (new, setup, list, remove,
  merge, purge, pr, open, path, cd, extract, config). Each exports a
  `*Handler`.
- `src/utils/*.ts` — shared helpers: `git.ts` (all git plumbing),
  `paths.ts` (worktree path/name resolution), `atomic.ts` (create-with-rollback),
  `pr.ts` (PR/MR reference parsing + repo-ownership validation, shared by
  `open`/`pr`), `herdr.ts`, `tui.ts`, `workflow.ts`, `setup.ts`, `shutdown.ts`,
  `spinner.ts`.
- `src/config.ts` — `conf`-backed settings (editor, provider, worktreepath,
  herdr).
- `build/` is **not committed**; it is produced by `tsc` locally and in CI.

## Commands

```bash
pnpm build      # tsc -> build/ (postbuild chmods build/index.js to 0755)
pnpm dev        # tsc -w
pnpm test       # vitest run; pretest hook builds first
pnpm start      # node build/index.js
```

Run a single test file: `pnpm test -- path.test.ts`.

## Conventions

- **ESM imports use `.js` extensions** for local files (e.g.
  `import { ... } from "../utils/git.js"`), even though the source is `.ts`.
  Required by Node16 module resolution.
- **execa strips the final newline by default**, so `stdout` from git commands
  is already trimmed. Don't add redundant `.trim()` "fixes" assuming a trailing
  `\n`; do `.trim()` only when parsing multi-line output.
- **Error handling**: command handlers wrap work in try/catch, print a red
  message with `chalk`, and call `process.exit(1)` on failure (or `exit(0)` on a
  user-cancelled prompt). Keep this pattern; don't throw past the handler.
- Worktree creation goes through `AtomicWorktreeOperation` (`atomic.ts`) so a
  failure rolls back; preserve that when touching `new`/`setup`/`pr`/`extract`.
- Dirty main-worktree handling uses stash-by-hash: `stashChanges` →
  `applyAndDropStash` (see `git.ts`/`workflow.ts`). It uses `git stash create`
  (a dangling commit), not the stash stack.
- The herdr integration is **best-effort**: never let a herdr failure break a
  command. `WT_DISABLE_HERDR=1` skips it for one invocation.

## Path resolution (`src/utils/paths.ts`)

`resolveWorktreePath` has three cases: explicit `--path`; a configured global
`defaultWorktreePath` (namespaced by repo name); otherwise a **sibling of the
repo root** named `<repoDirName>-<sanitizedBranch>`. Branch `/` is replaced with
`-`. Anchor the sibling case to the repo root (`getRepoRoot`), not `cwd`, so it
is correct when run from a subdirectory. `wt path` must print exactly what
`wt new` would create.

## Target resolution (`wt open`)

`wt open <target>` resolves, in order: existing path → exact branch → worktree
folder name (basename) → PR/MR reference. A `#123` or a PR/MR URL is treated as
an explicit PR reference; a bare `123` is tried locally first and only falls back
to PR resolution when nothing local matches (so a branch/folder named `123`
wins, and no network call happens on a local hit). `open` never creates or
fetches: for a PR with no worktree it points at `wt pr`, and for a local branch
with no worktree it points at `wt new`. PR reference parsing and repo-ownership
validation for URLs live in `src/utils/pr.ts` and are shared with `wt pr`, which
accepts the same `#123`/`123`/URL forms.

## Testing

- Vitest, `test/**/*.test.ts`. Integration tests run the **built** CLI
  (`build/index.js`) against a real temp git repo, so `pretest` builds first.
- Isolate state in tests: set `WT_CONFIG_DIR` to a temp dir (config store),
  `WT_DISABLE_HERDR=1`, and `WT_EDITOR=none` (the last one is honored by
  `getDefaultEditor` so tests never launch a real editor). Init repos with
  `git init -b main` and
  `git config commit.gpgsign false` (tests must not depend on the user's signing
  agent). On macOS temp paths are symlinked (`/var` → `/private/var`); compare
  against `realpath`.
- Add a regression test with every bug fix.

## Commits & branches

- Conventional Commits: `type(scope): description` (feat, fix, chore, docs,
  style, refactor, test, perf).
- Never mention AI tooling in commits, PRs, or any repo-visible text.
- Default branch is `main`. Don't commit or push unless explicitly asked.

## Releasing vs. updating the local install

These are two separate actions, kept in two separate scripts by design. Do not
merge them:

- `scripts/release.sh <X.Y.Z>` only cuts and publishes a release. It gates on a
  clean tree + green `pnpm test`, generates the `CHANGELOG.md` entry and GitHub
  release notes from commit subjects since the last tag, bumps `package.json`,
  commits (`chore(release): vX.Y.Z`), tags, pushes, and publishes the release.
  CI (`.github/workflows/release.yml`) then builds, packs the tarball, and
  attaches it. It must not touch the local install.
- `scripts/update-local.sh` only updates this machine's global `wt` install to
  the latest published release.

A global install made with `pnpm add -g <url>` pins the resolved versioned
tarball URL, so it never follows later releases on its own.

After cutting a release, offer to update the local install, and run
`scripts/update-local.sh` if the user asks (or has already said to do it
automatically). Never update the local install as a side effect of releasing.
