import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from './mocks/vscode';

vi.mock('../src/authResolver', () => ({
    REMOTE_SSH_AUTHORITY: 'ssh-remote',
    RemoteSSHResolver: class {
        public dispose(): void {
        }
    },
}));

vi.mock('../src/cloudMode', () => ({
    initializeCloudMode: vi.fn(),
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
}));

import { activate, deactivate } from '../src/extension';

describe('extension activation API', () => {
    beforeEach(() => {
        vscode.authentication.getSession.mockReset();
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
            'createContainer',
            'deleteContainer',
            'getContainer',
            'getContainerIds',
            'restartContainer',
            'startContainer',
            'stopContainer',
        ]);
        expect((exports as unknown as Record<string, unknown>).admin).toBeUndefined();
        expect((exports as unknown as Record<string, unknown>).checkAdmin).toBeUndefined();

        await expect(exports.getContainerIds()).rejects.toMatchObject({
            code: 'api_url_missing',
            message: '未配置后端 REST API 地址',
        });

        deactivate();
    });
});
