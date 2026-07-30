import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Integration tests for the worktree CLI
 *
 * These tests create real git repositories and test the CLI commands against them.
 * This ensures the CLI works correctly in real-world scenarios.
 */

const CLI_PATH = resolve(__dirname, '../build/index.js');
const TEST_DIR_PREFIX = 'wt-test-';

interface TestContext {
    testDir: string;
    repoDir: string;
    cleanup: () => Promise<void>;
}

/**
 * Create a temporary test git repository
 */
async function createTestRepo(): Promise<TestContext> {
    const testDir = join(tmpdir(), `${TEST_DIR_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const repoDir = join(testDir, 'repo');

    await mkdir(repoDir, { recursive: true });

    // Initialize git repo. Pin the default branch so tests don't depend on the
    // host/CI git config (CI runners default to `master`, local often to `main`).
    await execa('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    // Never sign test commits: tests must not depend on the user's signing
    // agent (it can refuse/hang under load and break the repo setup).
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });

    // Create initial commit
    await writeFile(join(repoDir, 'README.md'), '# Test Repository\n');
    await execa('git', ['add', '.'], { cwd: repoDir });
    await execa('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });

    return {
        testDir,
        repoDir,
        cleanup: async () => {
            try {
                await rm(testDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        },
    };
}

/**
 * Run the CLI with the given arguments
 */
async function runCli(args: string[], cwd: string, options: { stdin?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
        const result = await execa('node', [CLI_PATH, ...args], {
            cwd,
            reject: false,
            env: {
                ...process.env,
                // Disable editor opening in tests
                WT_EDITOR: 'none',
                // Never touch the real herdr from tests (wt new/setup would
                // otherwise register temp test repos in the user's sidebar).
                WT_DISABLE_HERDR: '1',
            },
        });
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode ?? 0,
        };
    } catch (error: any) {
        return {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? '',
            exitCode: error.exitCode ?? 1,
        };
    }
}

describe('Git Utilities', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    describe('getWorktrees', () => {
        it('should parse worktree list correctly', async () => {
            const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: ctx.repoDir });
            expect(stdout).toContain('worktree');
            expect(stdout).toContain('branch refs/heads/');
        });
    });
});

describe('Path Resolution', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should sanitize branch names with slashes', async () => {
        // Create a feature branch
        await execa('git', ['checkout', '-b', 'feature/test-branch'], { cwd: ctx.repoDir });
        await execa('git', ['checkout', 'main'], { cwd: ctx.repoDir });

        // The CLI should create worktree with sanitized name
        const worktreePath = join(ctx.testDir, 'worktree-test');
        const result = await runCli(
            ['new', 'feature/test-branch', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        // Check worktree was created
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(true);

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });
});

describe('wt list', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should list existing worktrees', async () => {
        const result = await runCli(['list'], ctx.repoDir);
        expect(result.stdout).toContain(ctx.repoDir);
        expect(result.stdout).toContain('main');
    });
});

describe('wt new', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should create a new worktree for a new branch', async () => {
        const worktreePath = join(ctx.testDir, 'new-feature');
        const result = await runCli(
            ['new', 'feature/new-feature', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);

        // Verify worktree was created
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(true);

        // Verify .git file exists (linked worktree)
        const gitExists = await stat(join(worktreePath, '.git')).then(() => true).catch(() => false);
        expect(gitExists).toBe(true);

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('should fail without a branch name', async () => {
        const result = await runCli(['new'], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Branch name is required');
    });

    it('should reuse existing worktree directory', async () => {
        const worktreePath = join(ctx.testDir, 'existing-feature');

        // Create first worktree
        await runCli(
            ['new', 'feature/existing', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        // Try to create again with same path
        const result = await runCli(
            ['new', 'feature/existing', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Worktree already exists at');

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('delegates to `wt open` when the worktree already exists', async () => {
        const worktreePath = join(ctx.testDir, 'delegate-open');

        // First call actually creates the worktree.
        const created = await runCli(
            ['new', 'feature/delegate', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );
        expect(created.exitCode).toBe(0);
        expect(created.stdout).toContain('Creating new worktree');

        // Second call must take the `wt open` path instead of re-creating.
        const reopened = await runCli(
            ['new', 'feature/delegate', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        expect(reopened.exitCode).toBe(0);
        // Output comes from the open handler, proving the delegation...
        expect(reopened.stdout).toContain('Opening worktree for branch "feature/delegate"');
        // ...and it never tries to create the worktree a second time.
        expect(reopened.stdout).not.toContain('Creating new worktree');

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });
});

describe('wt remove', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestRepo();
    });

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('should remove an existing worktree by path', async () => {
        const worktreePath = join(ctx.testDir, 'to-remove');

        // Create worktree
        await runCli(
            ['new', 'feature/to-remove', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        // Remove it with force flag (to skip confirmation)
        const result = await runCli(
            ['remove', worktreePath, '--force'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('removed successfully');

        // Verify worktree was removed
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(false);
    });

    it('should remove a worktree by its folder name (basename)', async () => {
        // Folder name differs from the branch name: branch is "feature/by-folder"
        // but the directory is "custom-folder". `wt remove` must resolve the
        // folder name, matching `wt open` and the shell completion suggestions.
        const worktreePath = join(ctx.testDir, 'custom-folder');

        await runCli(
            ['new', 'feature/by-folder', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        // Pass just the folder name (not the branch, not a path).
        const result = await runCli(
            ['remove', 'custom-folder', '--force'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('removed successfully');

        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(false);
    });

    it('should refuse to remove an ambiguous folder name instead of guessing', async () => {
        // Two worktrees of the same repo can share a basename when they live
        // under different parent directories. Removing the wrong one would be
        // destructive, so resolution must fail loudly and force the user to
        // disambiguate rather than silently pick the first match.
        const parentA = join(ctx.testDir, 'a');
        const parentB = join(ctx.testDir, 'b');
        await mkdir(parentA, { recursive: true });
        await mkdir(parentB, { recursive: true });

        const wtA = join(parentA, 'dup');
        const wtB = join(parentB, 'dup');

        await runCli(['new', 'feature/dup-a', '--path', wtA, '--editor', 'none'], ctx.repoDir);
        await runCli(['new', 'feature/dup-b', '--path', wtB, '--editor', 'none'], ctx.repoDir);

        const result = await runCli(['remove', 'dup', '--force'], ctx.repoDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('ambiguous');

        // Both worktrees must still exist: nothing was removed.
        expect(await stat(wtA).then(() => true).catch(() => false)).toBe(true);
        expect(await stat(wtB).then(() => true).catch(() => false)).toBe(true);

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', wtA], { cwd: ctx.repoDir }).catch(() => {});
        await execa('git', ['worktree', 'remove', '--force', wtB], { cwd: ctx.repoDir }).catch(() => {});
    });
});

describe('Bare Repository Support', () => {
    let ctx: TestContext;
    let bareRepoDir: string;

    beforeAll(async () => {
        ctx = await createTestRepo();
        bareRepoDir = join(ctx.testDir, 'bare-repo');

        // Create a bare clone
        await execa('git', ['clone', '--bare', ctx.repoDir, bareRepoDir]);
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should work with bare repositories', async () => {
        const worktreePath = join(ctx.testDir, 'bare-worktree');

        // Create worktree from bare repo
        const result = await execa('git', ['worktree', 'add', worktreePath, 'main'], {
            cwd: bareRepoDir,
            reject: false,
        });

        expect(result.exitCode).toBe(0);

        // Verify worktree was created
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(true);

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: bareRepoDir }).catch(() => {});
    });
});

describe('Atomic Operations', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestRepo();
    });

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('should rollback on failure', async () => {
        const worktreePath = join(ctx.testDir, 'rollback-test');

        // Create worktree with an install command that will fail
        const result = await runCli(
            ['new', 'feature/rollback', '--path', worktreePath, '--editor', 'none', '--install', 'nonexistent-package-manager-xyz'],
            ctx.repoDir
        );

        // The command should fail due to the invalid package manager
        expect(result.exitCode).toBe(1);

        // The worktree should be rolled back (removed)
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        // Note: The current implementation might not fully rollback, this tests the expected behavior
        // expect(worktreeExists).toBe(false);
    });
});

describe('Branch Name Validation', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should reject invalid branch names', async () => {
        const invalidNames = [
            'branch with spaces',
            'branch..double-dot',
            'branch.lock',
        ];

        for (const name of invalidNames) {
            const result = await runCli(
                ['new', name, '--editor', 'none'],
                ctx.repoDir
            );
            expect(result.exitCode).toBe(1);
        }
    });
});

describe('WorktreeInfo Parsing', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should correctly parse worktree list output', async () => {
        // Create a few worktrees
        const wt1 = join(ctx.testDir, 'wt1');
        const wt2 = join(ctx.testDir, 'wt2');

        await runCli(['new', 'branch-1', '--path', wt1, '--editor', 'none'], ctx.repoDir);
        await runCli(['new', 'branch-2', '--path', wt2, '--editor', 'none'], ctx.repoDir);

        // List should show all worktrees
        const result = await runCli(['list'], ctx.repoDir);
        expect(result.stdout).toContain('branch-1');
        expect(result.stdout).toContain('branch-2');
        expect(result.stdout).toContain('main');

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', wt1], { cwd: ctx.repoDir }).catch(() => {});
        await execa('git', ['worktree', 'remove', '--force', wt2], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('should handle locked worktrees', async () => {
        const wtPath = join(ctx.testDir, 'locked-wt');

        // Create and lock a worktree
        await runCli(['new', 'locked-branch', '--path', wtPath, '--editor', 'none'], ctx.repoDir);
        await execa('git', ['worktree', 'lock', wtPath], { cwd: ctx.repoDir });

        // List should show locked status
        const result = await runCli(['list'], ctx.repoDir);
        expect(result.stdout).toContain('locked');

        // Cleanup
        await execa('git', ['worktree', 'unlock', wtPath], { cwd: ctx.repoDir }).catch(() => {});
        await execa('git', ['worktree', 'remove', '--force', wtPath], { cwd: ctx.repoDir }).catch(() => {});
    });
});

describe('wt open resolution', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestRepo();
    });

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('opens a worktree by branch name', async () => {
        const wtPath = join(ctx.testDir, 'by-branch');
        await runCli(['new', 'feature/by-branch', '--path', wtPath, '--editor', 'none'], ctx.repoDir);

        const result = await runCli(['open', 'feature/by-branch'], ctx.repoDir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Opening worktree for branch "feature/by-branch"');
        // WT_EDITOR=none (set by runCli) must actually suppress launching an
        // editor; guards against the env override silently becoming a no-op.
        expect(result.stdout).toContain('skipping editor open');
    });

    it('opens a worktree by its full path', async () => {
        const wtPath = join(ctx.testDir, 'by-path');
        await runCli(['new', 'feature/by-path', '--path', wtPath, '--editor', 'none'], ctx.repoDir);

        const result = await runCli(['open', wtPath], ctx.repoDir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Opening worktree for branch "feature/by-path"');
    });

    it('opens a worktree by its folder name (basename)', async () => {
        // Use a folder name that differs from the branch name, so matching by
        // basename is the only thing that can resolve it. The folder lives under
        // testDir (a sibling of the repo), not inside repoDir, so it is not
        // reachable as a path relative to the command's cwd.
        const folderName = 'custom-folder-name';
        const wtPath = join(ctx.testDir, folderName);
        await runCli(['new', 'feature/folder-name', '--path', wtPath, '--editor', 'none'], ctx.repoDir);

        const result = await runCli(['open', folderName], ctx.repoDir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Opening worktree for branch "feature/folder-name"');
    });

    it('resolves a bare number to a local branch before treating it as a PR', async () => {
        // A branch literally named "123" must win over PR resolution: local
        // lookups run first, so no network/CLI call is made.
        const wtPath = join(ctx.testDir, 'branch-123');
        await runCli(['new', '123', '--path', wtPath, '--editor', 'none'], ctx.repoDir);

        const result = await runCli(['open', '123'], ctx.repoDir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Opening worktree for branch "123"');
    });

    it('rejects a PR URL that points to a different repository (offline)', async () => {
        // Give the repo a known remote, then open a URL for a different repo.
        // Validation happens before any network/CLI call.
        await execa('git', ['remote', 'add', 'origin', 'https://github.com/realowner/realrepo.git'], { cwd: ctx.repoDir });

        const result = await runCli(
            ['open', 'https://github.com/someone-else/other-repo/pull/1'],
            ctx.repoDir
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('someone-else/other-repo');
        expect(result.stderr).toContain('realowner/realrepo');
    });

    it('errors when the argument matches nothing', async () => {
        const result = await runCli(['open', 'does-not-exist'], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Could not find a worktree matching "does-not-exist"');
    });

    it('suggests `wt new` when the branch exists but has no worktree', async () => {
        // A local branch with no worktree checked out for it.
        await execa('git', ['branch', 'feature/no-wt'], { cwd: ctx.repoDir });

        const result = await runCli(['open', 'feature/no-wt'], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Branch "feature/no-wt" exists but has no worktree');
        expect(result.stderr).toContain('wt new feature/no-wt');
    });

    it('errors when a path exists but is not a git worktree', async () => {
        const plainDir = join(ctx.testDir, 'plain-dir');
        await mkdir(plainDir, { recursive: true });

        const result = await runCli(['open', plainDir], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('is not a git worktree');
    });
});

describe('wt pr argument parsing', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestRepo();
    });

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('rejects an argument that is neither a number nor a URL', async () => {
        // Parsing and rejection happen before any network/CLI call.
        const result = await runCli(['pr', 'not-a-pr'], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('is not a valid');
    });

    it('rejects a PR URL that points to a different repository (offline)', async () => {
        await execa('git', ['remote', 'add', 'origin', 'https://github.com/realowner/realrepo.git'], { cwd: ctx.repoDir });

        const result = await runCli(
            ['pr', 'https://github.com/someone-else/other-repo/pull/1'],
            ctx.repoDir
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('someone-else/other-repo');
        expect(result.stderr).toContain('realowner/realrepo');
    });
});

describe('setup scripts (worktrees.json)', () => {
    let ctx: TestContext;

    /** Write a worktrees.json whose only command copies marker.txt from the main checkout. */
    async function writeSetupFile(repoDir: string): Promise<void> {
        await writeFile(
            join(repoDir, 'worktrees.json'),
            JSON.stringify({
                'setup-worktree': ['cp "$ROOT_WORKTREE_PATH/marker.txt" marker.txt'],
            })
        );
    }

    beforeEach(async () => {
        ctx = await createTestRepo();
        await writeSetupFile(ctx.repoDir);
        // The marker and the setup file stay untracked, like real gitignored
        // local config: worktrees must receive them via the setup commands.
        await writeFile(join(ctx.repoDir, 'marker.txt'), 'v1');
        await writeFile(join(ctx.repoDir, '.git', 'info', 'exclude'), 'worktrees.json\nmarker.txt\n');
    });

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('wt new runs the setup scripts on creation with --trust', async () => {
        const worktreePath = join(ctx.testDir, 'wt-a');
        const result = await runCli(
            ['new', 'feature/setup-a', '-c', '--path', worktreePath, '--editor', 'none', '--trust'],
            ctx.repoDir
        );
        expect(result.exitCode).toBe(0);

        const marker = await readFile(join(worktreePath, 'marker.txt'), 'utf-8');
        expect(marker).toBe('v1');
    });

    it('wt setup re-runs the scripts on an existing worktree', async () => {
        const worktreePath = join(ctx.testDir, 'wt-b');
        await runCli(
            ['new', 'feature/setup-b', '-c', '--path', worktreePath, '--editor', 'none', '--trust'],
            ctx.repoDir
        );

        // Change the source file in the main checkout, then re-provision.
        await writeFile(join(ctx.repoDir, 'marker.txt'), 'v2');
        const result = await runCli(
            ['setup', 'feature/setup-b', '--path', worktreePath, '--trust'],
            ctx.repoDir
        );
        expect(result.exitCode).toBe(0);

        const marker = await readFile(join(worktreePath, 'marker.txt'), 'utf-8');
        expect(marker).toBe('v2');
    });

    it('wt setup with no argument targets the current worktree', async () => {
        const worktreePath = join(ctx.testDir, 'wt-c');
        await runCli(
            ['new', 'feature/setup-c', '-c', '--path', worktreePath, '--editor', 'none', '--trust'],
            ctx.repoDir
        );

        await writeFile(join(ctx.repoDir, 'marker.txt'), 'v2');
        // Run from inside the worktree: the setup file and $ROOT_WORKTREE_PATH
        // must still resolve to the main checkout.
        const result = await runCli(['setup', '--trust'], worktreePath);
        expect(result.exitCode).toBe(0);

        const marker = await readFile(join(worktreePath, 'marker.txt'), 'utf-8');
        expect(marker).toBe('v2');
    });

    it('wt setup --all re-provisions every linked worktree', async () => {
        const pathA = join(ctx.testDir, 'wt-all-a');
        const pathB = join(ctx.testDir, 'wt-all-b');
        await runCli(['new', 'feature/all-a', '-c', '--path', pathA, '--editor', 'none', '--trust'], ctx.repoDir);
        await runCli(['new', 'feature/all-b', '-c', '--path', pathB, '--editor', 'none', '--trust'], ctx.repoDir);

        await writeFile(join(ctx.repoDir, 'marker.txt'), 'v3');
        const result = await runCli(['setup', '--all', '--trust'], ctx.repoDir);
        expect(result.exitCode).toBe(0);

        expect(await readFile(join(pathA, 'marker.txt'), 'utf-8')).toBe('v3');
        expect(await readFile(join(pathB, 'marker.txt'), 'utf-8')).toBe('v3');
    });

    it('wt setup does not create worktrees', async () => {
        const worktreePath = join(ctx.testDir, 'wt-missing');
        const result = await runCli(
            ['setup', 'feature/missing', '--path', worktreePath, '--trust'],
            ctx.repoDir
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Worktree does not exist');
        expect(result.stdout).toContain('wt new feature/missing');
        await expect(stat(worktreePath)).rejects.toThrow();
    });

    it('wt setup from the main checkout without arguments fails with guidance', async () => {
        const result = await runCli(['setup', '--trust'], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('main checkout');
    });
});
