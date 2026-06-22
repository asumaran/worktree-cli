import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test: `wt pr` must register/focus the new worktree in herdr's
 * sidebar, just like `wt new` and `wt open` do. Previously `prWorktreeHandler`
 * never called `openInHerdr`, so PR worktrees were missing from the sidebar and
 * did not gain focus.
 *
 * The handler has a large collaborator surface, so we mock all of it and assert
 * the single behavior under test: that `openInHerdr` is invoked with the
 * resolved worktree path before the editor step.
 */

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('node:fs/promises', () => ({
    // Worktree directory does not exist yet, so `wt pr` creates it.
    stat: vi.fn(async () => { throw new Error('ENOENT'); }),
}));
vi.mock('../src/config.js', () => ({
    getDefaultEditor: vi.fn(() => 'none'),
    shouldSkipEditor: vi.fn((e: string) => e === 'none'),
    getGitProvider: vi.fn(() => 'gh'),
}));
vi.mock('../src/utils/git.js', () => ({
    isWorktreeClean: vi.fn(async () => true),
    isMainRepoBare: vi.fn(async () => true),
    detectGitProvider: vi.fn(async () => 'gh'),
    getWorktrees: vi.fn(async () => []),
    stashChanges: vi.fn(),
    applyAndDropStash: vi.fn(),
    getUpstreamRemote: vi.fn(async () => 'origin'),
}));
vi.mock('../src/utils/paths.js', () => ({
    resolveWorktreePath: vi.fn(async () => '/tmp/wt/repo/pr-branch'),
}));
vi.mock('../src/utils/setup.js', () => ({ runSetupScriptsSecure: vi.fn() }));
vi.mock('../src/utils/atomic.js', () => ({
    AtomicWorktreeOperation: class {
        createWorktree = vi.fn();
        runInstall = vi.fn();
        commit = vi.fn();
        rollback = vi.fn();
    },
}));
vi.mock('../src/utils/tui.js', () => ({
    handleDirtyState: vi.fn(),
    selectPullRequest: vi.fn(),
}));
vi.mock('../src/utils/spinner.js', () => ({
    withSpinner: vi.fn(async (_msg: string, fn: () => any) => fn()),
}));
vi.mock('../src/utils/shutdown.js', () => ({ onShutdown: vi.fn(() => () => {}) }));
vi.mock('../src/utils/herdr.js', () => ({ openInHerdr: vi.fn() }));

import { execa } from 'execa';
import { openInHerdr } from '../src/utils/herdr.js';
import { prWorktreeHandler } from '../src/commands/pr.js';

describe('prWorktreeHandler herdr integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(execa).mockImplementation((cmd: any) => {
            // `gh pr view` resolves the PR head branch name.
            if (cmd === 'gh') return Promise.resolve({ stdout: 'pr-branch' }) as any;
            // git rev-parse / git fetch and anything else: succeed quietly.
            return Promise.resolve({ stdout: '' }) as any;
        });
    });

    it('registers the new PR worktree in herdr (matching wt new / wt open)', async () => {
        await prWorktreeHandler('123', { editor: 'none' });

        expect(openInHerdr).toHaveBeenCalledWith('/tmp/wt/repo/pr-branch');
    });
});
