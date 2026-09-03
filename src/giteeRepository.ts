export interface ParsedGiteeRepository {
    user: string;
    repository: string;
    url: string;
}

const HTTPS_REPOSITORY_PATTERN = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/?$/i;
const SSH_REPOSITORY_PATTERN = /^(git@[^:\s]+:)([^/\s]+)\/([^/\s]+)\/?$/i;

export function parseGiteeRepositoryUrl(input: string): ParsedGiteeRepository | undefined {
    const value = input.trim();
    if (!value) {
        return undefined;
    }

    const httpsMatch = HTTPS_REPOSITORY_PATTERN.exec(value);
    if (httpsMatch) {
        const repository = removeGitSuffix(httpsMatch[3]);
        return repository
            ? { user: httpsMatch[2], repository, url: `${value.slice(0, value.indexOf('://'))}://${httpsMatch[1]}` }
            : undefined;
    }

    const sshMatch = SSH_REPOSITORY_PATTERN.exec(value);
    if (sshMatch) {
        const repository = removeGitSuffix(sshMatch[3]);
        return repository
            ? { user: sshMatch[2], repository, url: sshMatch[1] }
            : undefined;
    }

    return undefined;
}

export function looksLikeGiteeRepositoryUrl(input: string): boolean {
    return /^(?:https?:\/\/|git@)/i.test(input.trim());
}

function removeGitSuffix(repository: string): string {
    return repository.replace(/\.git$/i, '');
}
