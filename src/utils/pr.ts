import { execa } from "execa";
import { getGitProvider } from "../config.js";
import { detectGitProvider, getRepoIdentity, RepoIdentity } from "./git.js";

export type GitProvider = 'gh' | 'glab';

/**
 * A parsed reference to a Pull Request / Merge Request, extracted from a CLI
 * argument. Supports `#123`, a bare `123`, and full GitHub/GitLab URLs.
 */
export interface PrReference {
    /** The PR/MR number as a string (no leading `#`). */
    number: string;
    /**
     * `true` when the input unambiguously denotes a PR/MR (a `#123` prefix or a
     * URL). `false` for a bare number like `123`, which callers should treat as
     * a fallback after local (path/branch/folder) lookups fail.
     */
    explicit: boolean;
    /**
     * Present only when the reference came from a URL. Used to validate that the
     * URL points at the repository the command is being run in.
     */
    url?: { host: string; owner: string; repo: string };
}

/**
 * Parse a PR/MR reference out of a raw CLI argument.
 *
 * Accepted forms:
 * - `#123`                                  -> explicit
 * - `123`                                   -> non-explicit (fallback)
 * - `https://github.com/owner/repo/pull/123[/...]`            -> explicit
 * - `https://gitlab.com/group/proj/-/merge_requests/123[/...]` -> explicit
 *
 * Returns `null` when the argument is not a PR/MR reference (e.g. a branch name
 * or a filesystem path).
 */
export function parsePrReference(arg: string): PrReference | null {
    const trimmed = arg.trim();

    // URL form (GitHub PR or GitLab MR). Anything after the number is ignored
    // (e.g. `/files`, `/commits`, `/changes`, query string, fragment).
    if (/^https?:\/\//i.test(trimmed)) {
        let url: URL;
        try {
            url = new URL(trimmed);
        } catch {
            return null;
        }
        const host = url.hostname.toLowerCase();

        // GitHub: /<owner>/<repo>/pull/<n>
        const gh = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
        if (gh) {
            return { number: gh[3], explicit: true, url: { host, owner: gh[1], repo: gh[2] } };
        }

        // GitLab: /<namespace...>/<project>/-/merge_requests/<n>
        // Everything before `/-/` is the project path; take its last two
        // segments as owner/repo to match getRepoIdentity's parsing.
        const gl = url.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/|$)/);
        if (gl) {
            const segments = gl[1].split('/').filter(Boolean);
            const repo = segments[segments.length - 1] ?? '';
            const owner = segments[segments.length - 2] ?? '';
            return { number: gl[2], explicit: true, url: { host, owner, repo } };
        }

        return null;
    }

    // `#123`
    const hash = trimmed.match(/^#(\d+)$/);
    if (hash) {
        return { number: hash[1], explicit: true };
    }

    // Bare `123`
    if (/^\d+$/.test(trimmed)) {
        return { number: trimmed, explicit: false };
    }

    return null;
}

/**
 * Normalize a repository name for comparison (lowercase, strip a trailing
 * `.git`).
 */
function normalizeRepo(repo: string): string {
    return repo.replace(/\.git$/i, '').toLowerCase();
}

/**
 * Assert that a PR/MR URL points at the repository located at `cwd`.
 *
 * Throws a descriptive error when the URL's host/owner/repo does not match the
 * current repository's upstream remote. The host is only compared when it can
 * be determined for the local repo.
 */
export async function assertUrlMatchesRepo(
    url: { host: string; owner: string; repo: string },
    cwd: string = "."
): Promise<void> {
    let identity: RepoIdentity;
    try {
        identity = await getRepoIdentity(cwd);
    } catch (error: any) {
        throw new Error(
            `Cannot verify that the URL belongs to this repository: ${error.message || error}`
        );
    }

    const sameHost = !identity.host || identity.host === url.host;
    const sameOwner = identity.owner.toLowerCase() === url.owner.toLowerCase();
    const sameRepo = normalizeRepo(identity.repo) === normalizeRepo(url.repo);

    if (!sameHost || !sameOwner || !sameRepo) {
        const local = `${identity.owner}/${identity.repo}${identity.host ? ` (${identity.host})` : ''}`;
        throw new Error(
            `That URL points to ${url.owner}/${url.repo} (${url.host}), ` +
            `but the current repository is ${local}.\n` +
            `Run the command from the matching repository.`
        );
    }
}

/**
 * Resolve the effective git provider: the configured provider, overridden by
 * auto-detection from the remote URL when they disagree.
 */
export async function resolveProvider(cwd: string = "."): Promise<GitProvider> {
    let provider: GitProvider = getGitProvider();
    const detected = await detectGitProvider(cwd);
    if (detected && detected !== provider) {
        provider = detected;
    }
    return provider;
}

/**
 * Fetch PR branch name using the GitHub REST API (fallback when `gh` is absent).
 */
async function fetchGitHubPRBranch(prNumber: string, cwd: string): Promise<string> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error(
            "GITHUB_TOKEN environment variable is required when 'gh' CLI is not installed.\n" +
            "Please set it with: export GITHUB_TOKEN=your_token_here\n" +
            "You can create a token at: https://github.com/settings/tokens"
        );
    }

    const { owner, repo } = await getRepoIdentity(cwd);
    const url = `https://api.github.com/repos/${owner}/${normalizeRepo(repo)}/pulls/${prNumber}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(`Pull Request #${prNumber} not found.`);
        }
        if (response.status === 401) {
            throw new Error("GitHub authentication failed. Please check your GITHUB_TOKEN.");
        }
        throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const branchName = data.head?.ref;

    if (!branchName) {
        throw new Error("Could not extract branch name from GitHub API response.");
    }

    return branchName;
}

/**
 * Fetch MR branch name using the GitLab REST API (fallback when `glab` is absent).
 */
async function fetchGitLabMRBranch(prNumber: string, cwd: string): Promise<string> {
    const token = process.env.GITLAB_TOKEN;
    if (!token) {
        throw new Error(
            "GITLAB_TOKEN environment variable is required when 'glab' CLI is not installed.\n" +
            "Please set it with: export GITLAB_TOKEN=your_token_here\n" +
            "You can create a token at: https://gitlab.com/-/profile/personal_access_tokens"
        );
    }

    const { owner, repo } = await getRepoIdentity(cwd);
    // GitLab uses URL-encoded project path (owner/repo)
    const projectPath = encodeURIComponent(`${owner}/${normalizeRepo(repo)}`);
    const url = `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests/${prNumber}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(`Merge Request #${prNumber} not found.`);
        }
        if (response.status === 401) {
            throw new Error("GitLab authentication failed. Please check your GITLAB_TOKEN.");
        }
        throw new Error(`GitLab API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const branchName = data.source_branch;

    if (!branchName) {
        throw new Error("Could not extract branch name from GitLab API response.");
    }

    return branchName;
}

/**
 * Get the PR/MR head branch name using the gh/glab CLI, falling back to the
 * provider's REST API when the CLI is not installed.
 */
export async function getBranchNameFromPR(
    prNumber: string,
    provider: GitProvider,
    cwd: string = "."
): Promise<string> {
    const isPR = provider === 'gh';
    const requestType = isPR ? "Pull Request" : "Merge Request";
    const cliName = isPR ? "gh" : "glab";

    try {
        if (provider === 'gh') {
            const { stdout } = await execa("gh", [
                "pr", "view", prNumber,
                "--json", "headRefName",
                "-q", ".headRefName",
            ], { cwd });
            const branchName = stdout.trim();
            if (!branchName) {
                throw new Error("Could not extract branch name from PR details.");
            }
            return branchName;
        } else {
            const { stdout } = await execa("glab", ["mr", "view", prNumber, "-o", "json"], { cwd });
            let mrData;
            try {
                mrData = JSON.parse(stdout);
            } catch (parseError: any) {
                throw new Error(`Failed to parse GitLab MR response: ${parseError.message}`);
            }
            const branchName = mrData.source_branch;
            if (!branchName) {
                throw new Error("Could not extract branch name from MR details.");
            }
            return branchName;
        }
    } catch (error: any) {
        // Check if this is a "CLI not found" error (ENOENT)
        if (error.code === 'ENOENT' || error.message?.includes("ENOENT")) {
            console.log(`${cliName} CLI not found. Attempting to use ${isPR ? 'GitHub' : 'GitLab'} REST API...`);

            try {
                // Fallback to REST API
                if (provider === 'gh') {
                    return await fetchGitHubPRBranch(prNumber, cwd);
                } else {
                    return await fetchGitLabMRBranch(prNumber, cwd);
                }
            } catch (apiError: any) {
                throw new Error(
                    `Failed to fetch ${requestType} via API: ${apiError.message}\n` +
                    `Alternatively, install the ${cliName} CLI: brew install ${cliName}`
                );
            }
        }

        // Handle other errors from CLI
        if (error.stderr?.includes("Could not find") || error.stderr?.includes("not found")) {
            throw new Error(`${requestType} #${prNumber} not found.`);
        }
        if (error.stderr?.includes(`${cliName} not found`)) {
            throw new Error(`${isPR ? 'GitHub' : 'GitLab'} CLI ('${cliName}') not found. Please install it (brew install ${cliName}) and authenticate (${cliName} auth login).`);
        }
        throw new Error(`Failed to get ${requestType} details: ${error.message || error.stderr || error}`);
    }
}
