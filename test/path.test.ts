import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * `wt path` Integration Tests
 *
 * `wt path <branch>` must print the exact same path `wt new` would create,
 * without creating anything, so external tools can agree on worktree
 * locations. These tests run the built CLI against a real temp git repo with an
 * isolated config directory.
 */

const CLI_PATH = resolve(__dirname, '../build/index.js');

describe('wt path', () => {
    let testDir: string;
    let repoDir: string;
    let configDir: string;

    async function run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const result = await execa('node', [CLI_PATH, ...args], {
            cwd,
            reject: false,
            env: {
                ...process.env,
                // Isolate the config store from the real user config.
                WT_CONFIG_DIR: configDir,
            },
        });
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode ?? 0,
        };
    }

    beforeEach(async () => {
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        testDir = join(tmpdir(), `wt-path-test-${unique}`);
        repoDir = join(testDir, 'repo');
        configDir = join(testDir, 'config');
        await mkdir(repoDir, { recursive: true });
        await mkdir(configDir, { recursive: true });

        await execa('git', ['init'], { cwd: repoDir });
        await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
        await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
        await writeFile(join(repoDir, 'README.md'), '# Test\n');
        await execa('git', ['add', '.'], { cwd: repoDir });
        await execa('git', ['commit', '-m', 'init'], { cwd: repoDir });
    });

    afterEach(async () => {
        try {
            await rm(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    it('prints {base}/{repo}/{branch} when a worktree path is configured', async () => {
        const base = join(testDir, 'wt-base');
        await run(['config', 'set', 'worktreepath', base], repoDir);

        const result = await run(['path', 'feature/auth'], repoDir);

        expect(result.exitCode).toBe(0);
        // Repo has no remote, so repo name falls back to the repo dir basename.
        expect(result.stdout.trim()).toBe(join(base, 'repo', 'feature-auth'));
    });

    it('sanitizes branch slashes into dashes', async () => {
        const base = join(testDir, 'wt-base');
        await run(['config', 'set', 'worktreepath', base], repoDir);

        const result = await run(['path', 'user/john/feature'], repoDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(join(base, 'repo', 'user-john-feature'));
    });

    it('prints only the path on stdout (capturable by other tools)', async () => {
        const base = join(testDir, 'wt-base');
        await run(['config', 'set', 'worktreepath', base], repoDir);

        const result = await run(['path', 'main'], repoDir);

        expect(result.exitCode).toBe(0);
        // Exactly one line, no decorations.
        expect(result.stdout.split('\n')).toHaveLength(1);
        expect(result.stdout.trim()).toBe(join(base, 'repo', 'main'));
    });

    it('falls back to sibling-directory behavior when no path is configured', async () => {
        const result = await run(['path', 'feature/x'], repoDir);

        expect(result.exitCode).toBe(0);
        // The sibling path is derived from the CLI's cwd, which on macOS
        // resolves symlinks (/var -> /private/var), so compare against realpath.
        const realRepoDir = await realpath(repoDir);
        expect(result.stdout.trim()).toBe(join(dirname(realRepoDir), 'repo-feature-x'));
    });

    it('exits non-zero when run outside a git repository', async () => {
        const result = await run(['path', 'feature/x'], testDir);

        expect(result.exitCode).not.toBe(0);
    });

    it('exits non-zero when the branch argument is missing', async () => {
        const result = await run(['path'], repoDir);

        expect(result.exitCode).not.toBe(0);
    });
});
