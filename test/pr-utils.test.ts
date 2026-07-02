import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parsePrReference, assertUrlMatchesRepo } from '../src/utils/pr.js';
import { getRepoIdentity } from '../src/utils/git.js';

/**
 * Unit tests for the PR/MR reference parsing and repository-matching helpers.
 * These are the pure/offline pieces behind `wt open <pr-ref>`.
 */

describe('parsePrReference', () => {
    it('parses an explicit #N reference', () => {
        expect(parsePrReference('#123')).toEqual({ number: '123', explicit: true });
    });

    it('parses a bare number as a non-explicit reference', () => {
        expect(parsePrReference('123')).toEqual({ number: '123', explicit: false });
    });

    it('trims surrounding whitespace', () => {
        expect(parsePrReference('  #42  ')).toEqual({ number: '42', explicit: true });
        expect(parsePrReference('  42  ')).toEqual({ number: '42', explicit: false });
    });

    it('returns null for branch-like names', () => {
        expect(parsePrReference('feature/foo')).toBeNull();
        expect(parsePrReference('abc')).toBeNull();
        expect(parsePrReference('123abc')).toBeNull();
        expect(parsePrReference('#abc')).toBeNull();
        expect(parsePrReference('')).toBeNull();
        expect(parsePrReference('release-123')).toBeNull();
    });

    it('parses a GitHub PR URL and ignores trailing path segments', () => {
        expect(parsePrReference('https://github.com/masmovil/monorepo-front/pull/5881/changes')).toEqual({
            number: '5881',
            explicit: true,
            url: { host: 'github.com', owner: 'masmovil', repo: 'monorepo-front' },
        });
    });

    it('parses a plain GitHub PR URL', () => {
        expect(parsePrReference('https://github.com/owner/repo/pull/7')).toEqual({
            number: '7',
            explicit: true,
            url: { host: 'github.com', owner: 'owner', repo: 'repo' },
        });
    });

    it('parses a GitHub PR URL with /files and a query string', () => {
        expect(parsePrReference('https://github.com/owner/repo/pull/7/files?w=1')).toEqual({
            number: '7',
            explicit: true,
            url: { host: 'github.com', owner: 'owner', repo: 'repo' },
        });
    });

    it('lowercases the host but preserves owner/repo casing', () => {
        expect(parsePrReference('HTTPS://GitHub.com/Owner/Repo/pull/9')).toEqual({
            number: '9',
            explicit: true,
            url: { host: 'github.com', owner: 'Owner', repo: 'Repo' },
        });
    });

    it('parses a GitLab MR URL', () => {
        expect(parsePrReference('https://gitlab.com/group/proj/-/merge_requests/42')).toEqual({
            number: '42',
            explicit: true,
            url: { host: 'gitlab.com', owner: 'group', repo: 'proj' },
        });
    });

    it('parses a GitLab MR URL with subgroups using the last two segments', () => {
        expect(parsePrReference('https://gitlab.com/group/sub/proj/-/merge_requests/8/diffs')).toEqual({
            number: '8',
            explicit: true,
            url: { host: 'gitlab.com', owner: 'sub', repo: 'proj' },
        });
    });

    it('returns null for non-PR URLs', () => {
        expect(parsePrReference('https://github.com/owner/repo')).toBeNull();
        expect(parsePrReference('https://github.com/owner/repo/issues/5')).toBeNull();
        expect(parsePrReference('https://github.com/owner/repo/pull/notanumber')).toBeNull();
        expect(parsePrReference('not a url at all')).toBeNull();
    });
});

interface TestContext {
    testDir: string;
    repoDir: string;
    cleanup: () => Promise<void>;
}

async function createRepoWithRemote(remoteUrl: string | null): Promise<TestContext> {
    const testDir = join(tmpdir(), `wt-pr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const repoDir = join(testDir, 'repo');

    await mkdir(repoDir, { recursive: true });
    await execa('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
    await writeFile(join(repoDir, 'README.md'), '# Test\n');
    await execa('git', ['add', '.'], { cwd: repoDir });
    await execa('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });

    if (remoteUrl) {
        await execa('git', ['remote', 'add', 'origin', remoteUrl], { cwd: repoDir });
    }

    return {
        testDir,
        repoDir,
        cleanup: async () => {
            await rm(testDir, { recursive: true, force: true }).catch(() => {});
        },
    };
}

describe('getRepoIdentity', () => {
    it('parses owner/repo/host from an HTTPS remote (stripping .git)', async () => {
        const ctx = await createRepoWithRemote('https://github.com/masmovil/monorepo-front.git');
        try {
            const identity = await getRepoIdentity(ctx.repoDir);
            expect(identity).toEqual({ host: 'github.com', owner: 'masmovil', repo: 'monorepo-front' });
        } finally {
            await ctx.cleanup();
        }
    });

    it('parses owner/repo/host from an SSH remote', async () => {
        const ctx = await createRepoWithRemote('git@github.com:owner/repo.git');
        try {
            const identity = await getRepoIdentity(ctx.repoDir);
            expect(identity).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' });
        } finally {
            await ctx.cleanup();
        }
    });

    it('throws when the repository has no remote', async () => {
        const ctx = await createRepoWithRemote(null);
        try {
            await expect(getRepoIdentity(ctx.repoDir)).rejects.toThrow();
        } finally {
            await ctx.cleanup();
        }
    });
});

describe('assertUrlMatchesRepo', () => {
    it('resolves when host/owner/repo all match (ignoring .git)', async () => {
        const ctx = await createRepoWithRemote('https://github.com/masmovil/monorepo-front.git');
        try {
            await expect(
                assertUrlMatchesRepo(
                    { host: 'github.com', owner: 'masmovil', repo: 'monorepo-front' },
                    ctx.repoDir
                )
            ).resolves.toBeUndefined();
        } finally {
            await ctx.cleanup();
        }
    });

    it('matches case-insensitively on owner and repo', async () => {
        const ctx = await createRepoWithRemote('https://github.com/Owner/Repo.git');
        try {
            await expect(
                assertUrlMatchesRepo({ host: 'github.com', owner: 'owner', repo: 'repo' }, ctx.repoDir)
            ).resolves.toBeUndefined();
        } finally {
            await ctx.cleanup();
        }
    });

    it('throws when the owner differs', async () => {
        const ctx = await createRepoWithRemote('https://github.com/owner/repo.git');
        try {
            await expect(
                assertUrlMatchesRepo({ host: 'github.com', owner: 'other', repo: 'repo' }, ctx.repoDir)
            ).rejects.toThrow(/current repository is owner\/repo/);
        } finally {
            await ctx.cleanup();
        }
    });

    it('throws when the repo differs', async () => {
        const ctx = await createRepoWithRemote('https://github.com/owner/repo.git');
        try {
            await expect(
                assertUrlMatchesRepo({ host: 'github.com', owner: 'owner', repo: 'different' }, ctx.repoDir)
            ).rejects.toThrow(/points to owner\/different/);
        } finally {
            await ctx.cleanup();
        }
    });

    it('throws when the host differs', async () => {
        const ctx = await createRepoWithRemote('https://github.com/owner/repo.git');
        try {
            await expect(
                assertUrlMatchesRepo({ host: 'gitlab.com', owner: 'owner', repo: 'repo' }, ctx.repoDir)
            ).rejects.toThrow();
        } finally {
            await ctx.cleanup();
        }
    });

    it('throws a verification error when there is no remote', async () => {
        const ctx = await createRepoWithRemote(null);
        try {
            await expect(
                assertUrlMatchesRepo({ host: 'github.com', owner: 'owner', repo: 'repo' }, ctx.repoDir)
            ).rejects.toThrow(/Cannot verify/);
        } finally {
            await ctx.cleanup();
        }
    });
});
