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

    it('registers the worktree with --focus when enabled and herdr is present', async () => {
        vi.mocked(isHerdrIntegrationEnabled).mockReturnValue(true);
        vi.mocked(execa).mockResolvedValue({} as any);

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
        vi.mocked(execa).mockRejectedValue(err);

        await expect(openInHerdr('/Users/me/wt/repo/feature-x')).resolves.toBeUndefined();
    });

    it('does not throw when the herdr command fails (e.g. server down)', async () => {
        vi.mocked(isHerdrIntegrationEnabled).mockReturnValue(true);
        vi.mocked(execa).mockRejectedValue(new Error('herdr server not running'));

        await expect(openInHerdr('/Users/me/wt/repo/feature-x')).resolves.toBeUndefined();
    });
});
