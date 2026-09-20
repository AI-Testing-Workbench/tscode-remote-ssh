import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from './mocks/vscode';
import { findRemoteLocation, handleOpenRecentUri, parseTargetDirectory } from '../src/openRecentUri';

class FakeHistory {
    constructor(private readonly entries: Record<string, string[]>) {
    }

    all(): Record<string, string[]> {
        return this.entries;
    }
}

type UriLike = Parameters<typeof handleOpenRecentUri>[0];
type HistoryLike = Parameters<typeof handleOpenRecentUri>[1];

function fakeUri(path: string, query: string): UriLike {
    return { path, query } as UriLike;
}

describe('parseTargetDirectory', () => {
    it('reads and decodes the dir parameter', () => {
        expect(parseTargetDirectory('dir=%2Fapp%2Fmy-repo&other=1')).toBe('/app/my-repo');
    });

    it('returns undefined when missing or blank', () => {
        expect(parseTargetDirectory('')).toBeUndefined();
        expect(parseTargetDirectory('dir=%20%20')).toBeUndefined();
    });
});

describe('findRemoteLocation', () => {
    const history = {
        'alice/repo': ['/app/repo'],
        'bob/other': ['/app/other'],
    };

    it('matches an exact recorded workspace', () => {
        expect(findRemoteLocation(history, '/app/repo')).toEqual({ host: 'alice/repo', path: '/app/repo' });
    });

    it('matches when the requested directory is inside the recorded workspace', () => {
        expect(findRemoteLocation(history, '/app/repo/packages/cli')).toEqual({ host: 'alice/repo', path: '/app/repo' });
    });

    it('ignores trailing slashes', () => {
        expect(findRemoteLocation(history, '/app/repo/')).toEqual({ host: 'alice/repo', path: '/app/repo' });
    });

    it('prefers the most specific recorded workspace', () => {
        const nested = {
            'alice/repo': ['/app'],
            'alice/repo-mono': ['/app/repo'],
        };
        expect(findRemoteLocation(nested, '/app/repo/cli')).toEqual({ host: 'alice/repo-mono', path: '/app/repo' });
    });

    it('does not match a recorded workspace outside the requested directory', () => {
        expect(findRemoteLocation(history, '/app')).toBeUndefined();
    });

    it('returns undefined without a usable directory', () => {
        expect(findRemoteLocation(history, '')).toBeUndefined();
    });

    it('ignores aliases that are no longer available', () => {
        expect(findRemoteLocation(history, '/app/repo', host => host === 'bob/other')).toBeUndefined();
    });
});

describe('handleOpenRecentUri', () => {
    beforeEach(() => {
        vscode.commands.executeCommand.mockReset();
    });

    it('opens the recorded remote workspace in the current window', async () => {
        const history = new FakeHistory({ 'alice/repo': ['/app/repo'] });

        await handleOpenRecentUri(fakeUri('/open', 'dir=%2Fapp%2Frepo%2Fcli'), history as unknown as HistoryLike, undefined, () => true);

        expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
        const [command, target, options] = vscode.commands.executeCommand.mock.calls[0];
        expect(command).toBe('vscode.openFolder');
        expect(target).toMatchObject({ scheme: 'vscode-remote', path: '/app/repo' });
        expect((target as { authority: string }).authority).toContain('ssh-remote+');
        expect(options).toEqual({ forceNewWindow: false });
    });

    it('does nothing when there is no matching record', async () => {
        const history = new FakeHistory({ 'alice/repo': ['/app/repo'] });

        await handleOpenRecentUri(fakeUri('/open', 'dir=%2Fapp%2Fmissing'), history as unknown as HistoryLike, undefined, () => true);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    });

    it('skips stale records whose host is no longer configured', async () => {
        const history = new FakeHistory({ 'stale/host': ['/app'], 'alice/repo': ['/app'] });

        await handleOpenRecentUri(fakeUri('/open', 'dir=%2Fapp'), history as unknown as HistoryLike, undefined, host => host === 'alice/repo');

        const [, target] = vscode.commands.executeCommand.mock.calls[0];
        expect(target).toMatchObject({ path: '/app' });
        expect((target as { authority: string }).authority).not.toContain('stale');
    });

    it('ignores unrelated paths', async () => {
        const history = new FakeHistory({ 'alice/repo': ['/app/repo'] });

        await handleOpenRecentUri(fakeUri('/other', 'dir=%2Fapp%2Frepo'), history as unknown as HistoryLike, undefined, () => true);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});
