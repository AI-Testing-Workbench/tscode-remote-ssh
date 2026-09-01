import { beforeEach, describe, expect, it } from 'vitest';
import { UserIdProvider, getCurrentUser, getCurrentUserId } from '../src/user';
import * as vscode from './mocks/vscode';

describe('user ID provider', () => {
    beforeEach(() => {
        vscode.authentication.getSession.mockReset();
    });

    it('reads the ID and label from a silent OAuth session', async () => {
        vscode.authentication.getSession.mockResolvedValue({
            account: { id: ' user-1 ', label: 'Alice' },
        });

        await expect(getCurrentUser()).resolves.toEqual({ userId: 'user-1', userName: 'Alice' });
        expect(vscode.authentication.getSession).toHaveBeenCalledWith('tscode-oauth', [], {
            createIfNone: false,
            silent: true,
        });
    });

    it('returns an empty ID when no session is available', async () => {
        vscode.authentication.getSession.mockResolvedValue(undefined);

        await expect(getCurrentUserId()).resolves.toBe('');
    });

    it('returns empty values for OAuth errors and malformed account fields', async () => {
        const errorProvider = new UserIdProvider(async () => {
            throw new Error('OAuth unavailable');
        });
        await expect(errorProvider.getCurrentUser()).resolves.toEqual({ userId: '', userName: '' });

        const malformedProvider = new UserIdProvider(async () => ({
            account: { id: 42, label: null },
        } as never));
        await expect(malformedProvider.getCurrentUser()).resolves.toEqual({ userId: '', userName: '' });
    });
});
