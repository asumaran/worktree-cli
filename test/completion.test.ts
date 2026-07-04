import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Shell completion tests.
 *
 * `wt completion <shell>` prints a static script; `wt __complete <command>` is
 * the hidden helper those scripts call to list dynamic candidates (worktrees or
 * branches) for a subcommand's first argument.
 */

const CLI_PATH = resolve(__dirname, '../build/index.js');

interface Repo {
    testDir: string;
    repoDir: string;
    configDir: string;
    cleanup: () => Promise<void>;
}

async function createRepo(): Promise<Repo> {
    const testDir = join(tmpdir(), `wt-completion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const repoDir = join(testDir, 'repo');
    const configDir = join(testDir, 'config');
    await mkdir(repoDir, { recursive: true });
    await mkdir(configDir, { recursive: true });

    await execa('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
    await writeFile(join(repoDir, 'README.md'), '# Test\n');
    await execa('git', ['add', '.'], { cwd: repoDir });
    await execa('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });

    return {
        testDir,
        repoDir,
        configDir,
        cleanup: async () => {
            try {
                await rm(testDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        },
    };
}

async function runCli(
    args: string[],
    cwd: string,
    configDir: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
        const result = await execa('node', [CLI_PATH, ...args], {
            cwd,
            reject: false,
            env: {
                ...process.env,
                WT_EDITOR: 'none',
                WT_DISABLE_HERDR: '1',
                WT_CONFIG_DIR: configDir,
            },
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
    } catch (error: any) {
        return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.exitCode ?? 1 };
    }
}

// Each line is "value" or "value<TAB>description"; strip the description.
const lines = (stdout: string): string[] =>
    stdout.split('\n').map(l => l.split('\t')[0].trim()).filter(Boolean);

// Parse "value<TAB>description" lines into a value -> description map.
const described = (stdout: string): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [value, description = ''] = line.split('\t');
        map[value.trim()] = description.trim();
    }
    return map;
};

describe('wt completion <shell>', () => {
    let repo: Repo;

    beforeEach(async () => {
        repo = await createRepo();
    });

    afterEach(async () => {
        await repo.cleanup();
    });

    it('prints a zsh completion script', async () => {
        const { stdout, exitCode } = await runCli(['completion', 'zsh'], repo.repoDir, repo.configDir);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('#compdef wt');
        expect(stdout).toContain('_wt()');
        expect(stdout).toContain('wt __complete');
    });

    it('prints a bash completion script', async () => {
        const { stdout, exitCode } = await runCli(['completion', 'bash'], repo.repoDir, repo.configDir);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('complete -F _wt_completions wt');
        expect(stdout).toContain('wt __complete');
    });

    it('prints a fish completion script', async () => {
        const { stdout, exitCode } = await runCli(['completion', 'fish'], repo.repoDir, repo.configDir);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('complete -c wt');
        expect(stdout).toContain('wt __complete');
    });

    it('rejects an unsupported shell with exit code 1', async () => {
        const { stderr, exitCode } = await runCli(['completion', 'powershell'], repo.repoDir, repo.configDir);
        expect(exitCode).toBe(1);
        expect(stderr).toContain('Unsupported shell');
    });
});

describe('wt __complete <command>', () => {
    let repo: Repo;

    beforeEach(async () => {
        repo = await createRepo();
        await execa('git', ['branch', 'feature/login'], { cwd: repo.repoDir });
        await execa('git', ['branch', 'bugfix-42'], { cwd: repo.repoDir });
    });

    afterEach(async () => {
        await repo.cleanup();
    });

    it('lists local branches (sorted) for branch commands like new', async () => {
        const { stdout, exitCode } = await runCli(['__complete', 'new'], repo.repoDir, repo.configDir);
        expect(exitCode).toBe(0);
        expect(lines(stdout)).toEqual(['bugfix-42', 'feature/login', 'main']);
    });

    it('hints the worktree folder for branches that already have one (new)', async () => {
        await runCli(['new', 'feature/login', '-p', 'wt-login'], repo.repoDir, repo.configDir);
        const { stdout } = await runCli(['__complete', 'new'], repo.repoDir, repo.configDir);
        const hints = described(stdout);
        // feature/login now has a worktree at "wt-login"; bugfix-42 has none.
        expect(hints['feature/login']).toBe('wt-login');
        expect(hints['bugfix-42']).toBe('');
    });

    it('lists one entry per worktree for open: folder as value, branch as hint', async () => {
        await runCli(['new', 'feature/login', '-p', 'wt-login'], repo.repoDir, repo.configDir);
        const { stdout } = await runCli(['__complete', 'open'], repo.repoDir, repo.configDir);
        const hints = described(stdout);
        // The feature worktree is keyed by its folder name, hinting the branch.
        expect(hints['wt-login']).toBe('feature/login');
        // The main worktree is keyed by its folder (the repo dir) and tagged main.
        expect(Object.keys(hints)).toContain('repo');
        expect(hints['repo']).toContain('main');
        // The branch name itself is no longer a standalone value.
        expect(Object.keys(hints)).not.toContain('feature/login');
    });

    it('excludes the main worktree for remove', async () => {
        await runCli(['new', 'feature/login', '-p', 'wt-login'], repo.repoDir, repo.configDir);
        const { stdout } = await runCli(['__complete', 'remove'], repo.repoDir, repo.configDir);
        const hints = described(stdout);
        expect(hints['wt-login']).toBe('feature/login');
        // The main worktree (folder "repo") must not be offered for removal.
        expect(Object.keys(hints)).not.toContain('repo');
    });

    it('prints nothing for commands without dynamic candidates (pr)', async () => {
        const { stdout, exitCode } = await runCli(['__complete', 'pr'], repo.repoDir, repo.configDir);
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('');
    });

    it('degrades gracefully (empty, exit 0) outside a git repository', async () => {
        const outside = join(repo.testDir, 'not-a-repo');
        await mkdir(outside, { recursive: true });
        const { stdout, exitCode } = await runCli(['__complete', 'open'], outside, repo.configDir);
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('');
    });
});
