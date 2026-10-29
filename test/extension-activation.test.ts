import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from './mocks/vscode';

const { captureContainerSyncOptions } = vi.hoisted(() => ({
    captureContainerSyncOptions: vi.fn(),
}));

vi.mock('../src/authResolver', () => ({
    REMOTE_SSH_AUTHORITY: 'ssh-remote',
    RemoteSSHResolver: class {
        public dispose(): void {
        }
    },
}));

vi.mock('../src/cloudMode', () => ({
    initializeCloudMode: vi.fn(),
    refreshCloudMode: vi.fn(() => false),
}));

vi.mock('../src/commands', () => ({
    openSSHConfigFile: vi.fn(),
    promptOpenRemoteSSHWindow: vi.fn(),
}));

vi.mock('../src/containerConfig', () => ({
    ContainerConfig: class {
    },
}));

vi.mock('../src/containerSync', () => ({
    ContainerSync: class {
        constructor(options: unknown) {
            captureContainerSyncOptions(options);
        }

        public start(): void {
        }

        public refresh(): Promise<unknown> {
            return Promise.resolve();
        }

        public dispose(): void {
        }
    },
}));

vi.mock('../src/hostTreeView', () => ({
    HostTreeDataProvider: class {
        public dispose(): void {
        }
    },
}));

vi.mock('../src/remoteLocationHistory', () => ({
    getRemoteWorkspaceLocationData: vi.fn(() => undefined),
    RemoteLocationHistory: class {
    },
}));

vi.mock('../src/sidebarView', () => ({
    SidebarSyncState: class {
        public update(): void {
        }

        public dispose(): void {
        }
    },
    SidebarViewProvider: class {
        public createContainerFromPrompt(): Promise<void> {
            return Promise.resolve();
        }

        public dispose(): void {
        }
    },
}));

import { activate, deactivate } from '../src/extension';

describe('extension activation API', () => {
    beforeEach(() => {
        vscode.authentication.getSession.mockReset();
        vscode.window.showErrorMessage.mockReset();
        vscode.window.showWarningMessage.mockReset();
        captureContainerSyncOptions.mockReset();
        vscode.resetConfiguration();
    });

    it('returns callable user-only exports from activate', async () => {
        vscode.authentication.getSession.mockResolvedValue({
            account: { id: 'user-1', label: 'Alice' },
        });
        const context = {
            subscriptions: [],
        } as unknown as Parameters<typeof activate>[0];

        const exports = await activate(context);

        expect(Object.keys(exports).sort()).toEqual([
            'checkAdmin',
            'createContainer',
            'deleteContainer',
            'getActiveServiceIds',
            'getContainer',
            'restartContainer',
            'revealSidebar',
            'startContainer',
            'stopContainer',
            'syncFiles',
        ]);
        expect((exports as unknown as Record<string, unknown>).admin).toBeUndefined();
        expect((exports as unknown as Record<string, unknown>).getContainerIds).toBeUndefined();

        deactivate();
    });

    it('uses a warning for an empty endpoint and a modal for a malformed endpoint', async () => {
        vscode.authentication.getSession.mockResolvedValue({
            account: { id: 'user-1', label: 'Alice' },
        });
        const context = {
            subscriptions: [],
        } as unknown as Parameters<typeof activate>[0];

        await activate(context);

        const options = captureContainerSyncOptions.mock.calls[0]?.[0] as {
            onInvalidEndpoint?: (event: { serviceId: string; endpoint: string | null | undefined }) => void;
        };
        expect(options.onInvalidEndpoint).toBeDefined();

        options.onInvalidEndpoint?.({ serviceId: 'service-empty', endpoint: null });
        expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('服务 "service-empty" 暂无可用 endpoint'),
        );
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();

        options.onInvalidEndpoint?.({ serviceId: 'service-invalid', endpoint: 'bad-endpoint' });
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '云端沙箱 服务 "service-invalid" 的 endpoint 无效，应为 IP:Port：bad-endpoint',
            { modal: true },
            '复制',
        );

        deactivate();
    });
});
