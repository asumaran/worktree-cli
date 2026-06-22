## v1.2.2 (2026-06-22)

* fix(pr): register the PR worktree in the herdr sidebar (9e22e58)
* docs: add CLAUDE.md with development and release guidance (ce897ff)
* feat(scripts): add update-local.sh to update the global install (1a38008)

## v1.2.1 (2026-06-21)

* fix(paths): resolve sibling worktree path against the repo root (987e67c)
* build(release): generate the changelog and release notes automatically (03cf714)
* docs(readme): install from the stable release URL (4bfa6a6)

## v1.2.0 (2026-06-21)

### Features

* **open:** `wt open` now registers and focuses the reopened worktree in the [herdr](https://herdr.dev) sidebar, matching `wt new`. Best-effort and no-op when herdr isn't installed or the integration is off.

### Refactor

* **new:** when the target worktree already exists, `wt new` delegates to `wt open` instead of duplicating the reuse/open logic, so creating and reopening share a single code path.

### Build

* run the build before tests via an npm `pretest` hook, so the integration suite (which runs against `build/`) never tests stale output. Drops the now-redundant explicit build step from `scripts/release.sh`.

## v1.1.2 (2026-06-21)

### Features

* **herdr:** add `WT_DISABLE_HERDR=1` to skip the herdr integration for a single invocation (escape hatch for CI/scripts), without changing config. Ships the kill-switch that was documented in v1.1.1 but not yet in the released build.

### Build

* add `scripts/release.sh`: a release is gated on a clean tree plus a green `pnpm build`/`pnpm test`, and the tag always matches the committed state (prevents release/`main` drift).

## v1.1.1 (2026-06-21)

### Bug Fixes

* **herdr:** pass `--cwd <repo-root>` to `herdr worktree open` so the worktree resolves from its parent repo workspace (the CLI talks to the server over a socket and does not inherit the caller's cwd). Without it herdr returned `worktree_not_found`.

## v1.1.0 (2026-06-21)

### Features

* **path:** add `wt path <branch>` to print the resolved worktree path without creating anything, so other tools can agree on worktree locations.
* **herdr:** register newly created/reused worktrees in the [herdr](https://herdr.dev) sidebar via `herdr worktree open --path <path> --focus`. Best-effort and no-op when herdr isn't installed. Toggle with `wt config set herdr <on|off>`.

### Bug Fixes

* **config:** honor `WT_CONFIG_DIR` to isolate the config store, so test runs no longer clobber the real user config on macOS (where `conf` ignores `XDG_CONFIG_HOME`).

## [2.0.2](https://github.com/johnlindquist/worktree-cli/compare/v2.0.1...v2.0.2) (2025-03-20)


### Bug Fixes

* **build:** no commit ([914fc32](https://github.com/johnlindquist/worktree-cli/commit/914fc3226ded49891e0cb409aeffcb25782213ef))
* **new:** create branch ([459e326](https://github.com/johnlindquist/worktree-cli/commit/459e326c5596b9c190bf5de2be00b777ed5cdda4))

## [2.0.1](https://github.com/johnlindquist/worktree-cli/compare/v2.0.0...v2.0.1) (2025-03-20)


### Bug Fixes

* **new:** create branch ([207d601](https://github.com/johnlindquist/worktree-cli/commit/207d6011ff7a7835c4609aeb6fd8796addf05b1f))

# [2.0.0](https://github.com/johnlindquist/worktree-cli/compare/v1.2.1...v2.0.0) (2025-03-20)


### Features

* change CLI command name to 'wt' ([4a8a562](https://github.com/johnlindquist/worktree-cli/commit/4a8a5620c3b24cabf4b222179e9a44502015e469))


### BREAKING CHANGES

* The CLI command has been renamed from '@johnlindquist/worktree' to 'wt' for better usability. All users will need to update their commands to use 'wt' instead of '@johnlindquist/worktree'.

## [1.2.1](https://github.com/johnlindquist/worktree-cli/compare/v1.2.0...v1.2.1) (2025-03-20)


### Bug Fixes

* **new:** add dash ([7cbc3b3](https://github.com/johnlindquist/worktree-cli/commit/7cbc3b3aad0af07eccab703cc6546d58f1556b8f))

# [1.2.0](https://github.com/johnlindquist/worktree-cli/compare/v1.1.0...v1.2.0) (2025-03-20)


### Features

* add shorthand flags -i and -e for --install and --editor ([8c6f4de](https://github.com/johnlindquist/worktree-cli/commit/8c6f4de0bb9f0293c816e1f1176acbe86f7132d6))

# [1.1.0](https://github.com/johnlindquist/worktree-cli/compare/v1.0.0...v1.1.0) (2025-03-20)


### Features

* create worktrees in sibling directories ([37dc420](https://github.com/johnlindquist/worktree-cli/commit/37dc420cf1539c68a32926e97c2f35762f5392b0))

# 1.0.0 (2025-03-20)


### Bug Fixes

* add write permissions for semantic-release ([d98cae6](https://github.com/johnlindquist/worktree-cli/commit/d98cae6472d06f9cb39f40c9df564143fdf577ef))
* switch to pnpm ([b95819e](https://github.com/johnlindquist/worktree-cli/commit/b95819e3abd9a44b5b06b0036bedfa5fe3d7c825))
* update Node.js version to 18 ([ab54632](https://github.com/johnlindquist/worktree-cli/commit/ab54632df1b7094fa6896470fa5f17efcce796f3))
* update Node.js version to 20.8.1 ([b9d2190](https://github.com/johnlindquist/worktree-cli/commit/b9d2190b5c3b55ce1376ed6c244701a57a8b3d8d))
* use npm install instead of npm ci ([988aac9](https://github.com/johnlindquist/worktree-cli/commit/988aac9a25d57da7d8d1923029211182e8a7e6a0))


### Features

* add semantic-release for automated versioning ([11cddea](https://github.com/johnlindquist/worktree-cli/commit/11cddea6295a76beeec42371d429cf1d899b269a))
