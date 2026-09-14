import { describe, expect, it, vi } from 'vitest';
import { promptForGitCredentials } from '../src/gitCredentialPrompt';

describe('promptForGitCredentials', () => {
    it('prefills editable identity values and returns a non-persistent credential request', async () => {
        const values = ['edited-user', 'edited@example.test', 'secret-token'];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => '否');
        const showErrorMessage = vi.fn(async () => undefined);
        const identityReader = { read: vi.fn(async () => ({ username: 'configured-user', email: 'configured@example.test' })) };

        await expect(promptForGitCredentials({ identityReader, showInputBox, showQuickPick, showErrorMessage })).resolves.toEqual({
            type: 'password',
            git_username: 'edited-user',
            git_email: 'edited@example.test',
            git_password: 'secret-token',
            persist: false,
        });
        expect(identityReader.read).toHaveBeenCalledOnce();
        expect(showInputBox).toHaveBeenNthCalledWith(1, expect.objectContaining({ value: 'configured-user' }));
        expect(showInputBox).toHaveBeenNthCalledWith(2, expect.objectContaining({ value: 'configured@example.test' }));
        expect(showInputBox).toHaveBeenNthCalledWith(3, expect.objectContaining({ password: true }));
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it('allows an empty email and supports persistent credentials', async () => {
        const values = ['git-user', '', 'secret-token'];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => '是');

        await expect(promptForGitCredentials({
            identityReader: { read: vi.fn(async () => ({ username: '', email: '' })) },
            showInputBox,
            showQuickPick,
        })).resolves.toMatchObject({
            git_username: 'git-user',
            git_email: '',
            git_password: 'secret-token',
            persist: true,
        });
    });

    it('keeps the prompt open for empty required fields and treats close as cancellation', async () => {
        const values: Array<string | undefined> = ['', undefined];
        const showInputBox = vi.fn(async () => values.shift());
        const showErrorMessage = vi.fn(async () => undefined);
        const showQuickPick = vi.fn();

        await expect(promptForGitCredentials({
            identityReader: { read: vi.fn(async () => ({ username: 'configured-user', email: '' })) },
            showInputBox,
            showQuickPick,
            showErrorMessage,
        })).resolves.toBeUndefined();
        expect(showErrorMessage).toHaveBeenCalledWith('码云用户名不能为空');
        expect(showQuickPick).not.toHaveBeenCalled();
    });

    it('treats password close and persistence close as cancellation', async () => {
        const onCancel = vi.fn(async () => undefined);
        const passwordClosed = await promptForGitCredentials({
            identityReader: { read: vi.fn(async () => ({ username: 'user', email: '' })) },
            showInputBox: vi.fn()
                .mockResolvedValueOnce('user')
                .mockResolvedValueOnce('')
                .mockResolvedValueOnce(undefined),
            showQuickPick: vi.fn(),
            onCancel,
        });
        expect(passwordClosed).toBeUndefined();

        const persistenceClosed = await promptForGitCredentials({
            identityReader: { read: vi.fn(async () => ({ username: 'user', email: '' })) },
            showInputBox: vi.fn()
                .mockResolvedValueOnce('user')
                .mockResolvedValueOnce('')
                .mockResolvedValueOnce('secret'),
            showQuickPick: vi.fn(async () => undefined),
            onCancel,
        });
        expect(persistenceClosed).toBeUndefined();
        expect(onCancel).toHaveBeenCalledTimes(2);
    });

    it('reads identity again when the credential page is reopened', async () => {
        const identityReader = {
            read: vi.fn()
                .mockResolvedValueOnce({ username: 'first-user', email: 'first@example.test' })
                .mockResolvedValueOnce({ username: 'second-user', email: 'second@example.test' }),
        };
        const showInputBox = vi.fn()
            .mockResolvedValueOnce('first-user')
            .mockResolvedValueOnce('first@example.test')
            .mockResolvedValueOnce('first-secret')
            .mockResolvedValueOnce('second-user')
            .mockResolvedValueOnce('second@example.test')
            .mockResolvedValueOnce('second-secret');
        const showQuickPick = vi.fn(async () => '否');

        await promptForGitCredentials({ identityReader, showInputBox, showQuickPick });
        await promptForGitCredentials({ identityReader, showInputBox, showQuickPick });

        expect(identityReader.read).toHaveBeenCalledTimes(2);
        expect(showInputBox).toHaveBeenNthCalledWith(4, expect.objectContaining({ value: 'second-user' }));
    });
});
