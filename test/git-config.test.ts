import { describe, expect, it, vi } from 'vitest';
import { GitConfigReader, type GitConfigCommandRunner } from '../src/gitConfig';

describe('GitConfigReader', () => {
    it('uses the active editor workspace before the first workspace and global config', async () => {
        const runGit = vi.fn<GitConfigCommandRunner>(async (args, cwd) => {
            const key = args[args.length - 1];
            if (args.includes('--local') && cwd === 'C:\\workspace-active') {
                return key === 'user.name' ? 'workspace-user\n' : 'workspace@example.test\n';
            }
            throw new Error('not used');
        });
        const reader = new GitConfigReader({
            runGit,
            getWorkspaceFolders: () => ['C:\\workspace-first', 'C:\\workspace-active'],
            getActiveEditorPath: () => 'C:\\workspace-active\\src\\main.ts',
        });

        await expect(reader.read()).resolves.toEqual({ username: 'workspace-user', email: 'workspace@example.test' });
        expect(runGit).toHaveBeenCalledTimes(2);
        expect(runGit).toHaveBeenNthCalledWith(1, ['config', '--local', '--get', 'user.name'], 'C:\\workspace-active');
        expect(runGit).toHaveBeenNthCalledWith(2, ['config', '--local', '--get', 'user.email'], 'C:\\workspace-active');
    });

    it('falls back per field to user-level repository config when the workspace value is absent', async () => {
        const runGit = vi.fn<GitConfigCommandRunner>(async args => {
            const key = args[args.length - 1];
            if (args.includes('--local')) {
                if (key === 'user.name') {
                    return 'local-user';
                }
                throw new Error('email is not configured locally');
            }
            return key === 'user.email' ? 'global@example.test' : 'global-user';
        });
        const reader = new GitConfigReader({
            runGit,
            getWorkspaceFolders: () => ['C:\\workspace'],
            getActiveEditorPath: () => 'C:\\other\\file.ts',
        });

        await expect(reader.read()).resolves.toEqual({ username: 'local-user', email: 'global@example.test' });
        expect(runGit).toHaveBeenCalledWith(['config', '--local', '--get', 'user.name'], 'C:\\workspace');
        expect(runGit).toHaveBeenCalledWith(['config', '--local', '--get', 'user.email'], 'C:\\workspace');
        expect(runGit).toHaveBeenCalledWith(['config', '--global', '--get', 'user.email'], undefined);
        expect(runGit).not.toHaveBeenCalledWith(['config', '--global', '--get', 'user.name'], undefined);
    });

    it('uses only user-level config without a workspace', async () => {
        const runGit = vi.fn<GitConfigCommandRunner>(async (args, cwd) => {
            expect(cwd).toBeUndefined();
            return args[args.length - 1] === 'user.name' ? 'global-user' : 'global@example.test';
        });
        const reader = new GitConfigReader({ runGit, getWorkspaceFolders: () => [] });

        await expect(reader.read()).resolves.toEqual({ username: 'global-user', email: 'global@example.test' });
        expect(runGit).toHaveBeenCalledTimes(2);
        expect(runGit).toHaveBeenCalledWith(['config', '--global', '--get', 'user.name'], undefined);
        expect(runGit).toHaveBeenCalledWith(['config', '--global', '--get', 'user.email'], undefined);
    });

    it('hides repository command failures and returns empty defaults', async () => {
        const runGit = vi.fn<GitConfigCommandRunner>(async () => {
            throw new Error('private command output');
        });
        const reader = new GitConfigReader({ runGit, getWorkspaceFolders: () => ['C:\\workspace'] });

        await expect(reader.read()).resolves.toEqual({ username: '', email: '' });
        expect(runGit).toHaveBeenCalledTimes(4);
    });
});
