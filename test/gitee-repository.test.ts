import { describe, expect, it } from 'vitest';
import { looksLikeGiteeRepositoryUrl, parseGiteeRepositoryUrl } from '../src/giteeRepository';

describe('Gitee repository input', () => {
    it('extracts the HTTP(S) repository fields with or without the git suffix', () => {
        expect(parseGiteeRepositoryUrl('https://github.com/JustWorkingAndWorking/testagent-cloud-remote-ssh.git'))
            .toEqual({
                user: 'JustWorkingAndWorking',
                repository: 'testagent-cloud-remote-ssh',
                url: 'https://github.com',
            });
        expect(parseGiteeRepositoryUrl('https://github.com/JustWorkingAndWorking/testagent-cloud-remote-ssh'))
            .toEqual({
                user: 'JustWorkingAndWorking',
                repository: 'testagent-cloud-remote-ssh',
                url: 'https://github.com',
            });
        expect(parseGiteeRepositoryUrl('http://github.com/JustWorkingAndWorking/testagent-cloud-remote-ssh'))
            .toEqual({
                user: 'JustWorkingAndWorking',
                repository: 'testagent-cloud-remote-ssh',
                url: 'http://github.com',
            });
        expect(parseGiteeRepositoryUrl('https://github.com/JustWorkingAndWorking/testagent-cloud-remote-ssh/tree/main?tab=readme'))
            .toEqual({
                user: 'JustWorkingAndWorking',
                repository: 'testagent-cloud-remote-ssh',
                url: 'https://github.com',
            });
    });

    it('extracts the SSH repository fields with or without the git suffix', () => {
        expect(parseGiteeRepositoryUrl('git@github.com:JustWorkingAndWorking/testagent-cloud-remote-ssh.git'))
            .toEqual({
                user: 'JustWorkingAndWorking',
                repository: 'testagent-cloud-remote-ssh',
                url: 'git@github.com:',
            });
        expect(parseGiteeRepositoryUrl('git@github.com:JustWorkingAndWorking/testagent-cloud-remote-ssh'))
            .toEqual({
                user: 'JustWorkingAndWorking',
                repository: 'testagent-cloud-remote-ssh',
                url: 'git@github.com:',
            });
    });

    it('distinguishes usernames, empty input, and malformed repository URLs', () => {
        expect(parseGiteeRepositoryUrl('JustWorkingAndWorking')).toBeUndefined();
        expect(looksLikeGiteeRepositoryUrl('JustWorkingAndWorking')).toBe(false);
        expect(parseGiteeRepositoryUrl('')).toBeUndefined();
        expect(looksLikeGiteeRepositoryUrl('https://github.com/owner')).toBe(true);
        expect(parseGiteeRepositoryUrl('https://github.com/owner')).toBeUndefined();
    });
});
