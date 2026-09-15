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

    it('notifies the user before retrying rejected credentials', async () => {
        const values = ['git-user', 'git@example.test', 'secret-token'];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => '否');
        const showErrorMessage = vi.fn(async () => undefined);

        await expect(promptForGitCredentials({
            identityReader: { read: vi.fn(async () => ({ username: '', email: '' })) },
            showInputBox,
            showQuickPick,
            showErrorMessage,
            gitStatus: 'credential_rejected',
        })).resolves.toMatchObject({
            git_username: 'git-user',
            git_password: 'secret-token',
        });
        expect(showErrorMessage).toHaveBeenCalledWith('码云凭证输入错误或缓存过期，请重试');
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

    it('treats an empty password after the validation message as cancellation', async () => {
        const onCancel = vi.fn(async () => undefined);
        const showInputBox = vi.fn()
            .mockResolvedValueOnce('user')
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce('');
        const showErrorMessage = vi.fn(async () => undefined);
        const showQuickPick = vi.fn();

        await expect(promptForGitCredentials({
            identityReader: { read: vi.fn(async () => ({ username: '', email: '' })) },
            showInputBox,
            showQuickPick,
            showErrorMessage,
            onCancel,
        })).resolves.toBeUndefined();
        expect(showErrorMessage).toHaveBeenCalledWith('码云密码不能为空');
        expect(showInputBox).toHaveBeenCalledTimes(3);
        expect(showQuickPick).not.toHaveBeenCalled();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('does not wait for the password validation message before cancelling', async () => {
        let resolveErrorMessage: (() => void) | undefined;
        const onCancel = vi.fn(async () => undefined);
        const showInputBox = vi.fn()
            .mockResolvedValueOnce('user')
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce('');
        const showErrorMessage = vi.fn(() => new Promise<void>(resolve => {
            resolveErrorMessage = resolve;
        }));
        const prompt = promptForGitCredentials({
            identityReader: { read: vi.fn(async () => ({ username: '', email: '' })) },
            showInputBox,
            showQuickPick: vi.fn(),
            showErrorMessage,
            onCancel,
        });

        await vi.waitFor(() => expect(showErrorMessage).toHaveBeenCalledWith('码云密码不能为空'));
        await expect(prompt).resolves.toBeUndefined();
        expect(onCancel).toHaveBeenCalledOnce();
        resolveErrorMessage?.();
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
