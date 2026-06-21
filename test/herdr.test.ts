import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * herdr Integration Tests
 *
 * Unit tests for the best-effort herdr integration. We mock `execa` and the
 * config module so the helper can be exercised without a real herdr install.
 */

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../src/config.js', () => ({ isHerdrIntegrationEnabled: vi.fn() }));

import { execa } from 'execa';
import { isHerdrIntegrationEnabled } from '../src/config.js';
import { openInHerdr } from '../src/utils/herdr.js';

describe('openInHerdr', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // openInHerdr first resolves the repo root via git, then calls herdr.
    // This helper mocks execa to answer both calls.
    function mockExeca(opts: { gitCommonDir?: string; herdr?: () => any } = {}) {
        vi.mocked(execa).mockImplementation((cmd: any, args: any) => {
            if (cmd === 'git') {
                return Promise.resolve({ stdout: opts.gitCommonDir ?? '/Users/me/dev/repo/.git' }) as any;
            }
            return (opts.herdr ? opts.herdr() : Promise.resolve({})) as any;
        });
    }

    it('registers the worktree with --cwd (repo root) and --focus when enabled', async () => {
        vi.mocked(isHerdrIntegrationEnabled).mockReturnValue(true);
        mockExeca({ gitCommonDir: '/Users/me/dev/repo/.git' });

        await openInHerdr('/Users/me/wt/repo/feature-x');

        expect(execa).toHaveBeenCalledWith('herdr', [
            'worktree',
            'open',
            '--cwd',
            '/Users/me/dev/repo',
            '--path',
            '/Users/me/wt/repo/feature-x',
            '--focus',
        ]);
    });

    it('still registers (without --cwd) when the repo root cannot be resolved', async () => {
        vi.mocked(isHerdrIntegrationEnabled).mockReturnValue(true);
        vi.mocked(execa).mockImplementation((cmd: any) => {
            if (cmd === 'git') return Promise.reject(new Error('not a git repo')) as any;
            return Promise.resolve({}) as any;
        });

        await openInHerdr('/Users/me/wt/repo/feature-x');

        expect(execa).toHaveBeenCalledWith('herdr', [
            'worktree',
            'open',
            '--path',
            '/Users/me/wt/repo/feature-x',
            '--focus',
        ]);
    });

    it('is a no-op when the integration is disabled', async () => {
        vi.mocked(isHerdrIntegrationEnabled).mockReturnValue(false);

        await openInHerdr('/Users/me/wt/repo/feature-x');

        expect(execa).not.toHaveBeenCalled();
    });

    it('does not throw when herdr is not installed (ENOENT)', async () => {
        vi.mocked(isHerdrIntegrationEnabled).mockReturnValue(true);
        const err: any = new Error('spawn herdr ENOENT');
        err.code = 'ENOENT';
        mockExeca({ herdr: () => Promise.reject(err) });

        await expect(openInHerdr('/Users/me/wt/repo/feature-x')).resolves.toBeUndefined();
    });

    it('does not throw when the herdr command fails (e.g. server down)', async () => {
        vi.mocked(isHerdrIntegrationEnabled).mockReturnValue(true);
        mockExeca({ herdr: () => Promise.reject(new Error('herdr server not running')) });

        await expect(openInHerdr('/Users/me/wt/repo/feature-x')).resolves.toBeUndefined();
    });
});
