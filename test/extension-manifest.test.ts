import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type ExtensionManifest = {
    activationEvents: string[];
    contributes: {
        commands: Array<{ command: string }>;
        menus: Record<string, Array<{ command: string }>>;
        views: {
            remote: Array<{ id: string; type?: string }>;
        };
        configuration: {
            properties: Record<string, {
                type: string;
                default: unknown;
                description?: string;
            }>;
        };
    };
};

const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as ExtensionManifest;

describe('extension manifest', () => {
    it('declares every menu command', () => {
        const commandIds = new Set(manifest.contributes.commands.map(({ command }) => command));
        const menuCommandIds = Object.values(manifest.contributes.menus)
            .flat()
            .map(({ command }) => command);

        expect(menuCommandIds.filter(command => !commandIds.has(command))).toEqual([]);
    });

    it('declares the cloud settings with their required defaults and types', () => {
        const properties = manifest.contributes.configuration.properties;

        expect(properties).toMatchObject({
            'testagnet.remote.backendApiUrl': { type: 'string', default: '' },
            'testagnet.remote.userName': { type: 'string', default: 'root' },
            'testagnet.remote.skipKnownHostsCheck': { type: 'boolean', default: true },
            'testagnet.remote.historyLimit': { type: 'integer', default: 5 },
            'testagnet.remote.statusSyncInterval': { type: 'number', default: 5 },
            'testagnet.remote.debug': { type: 'boolean', default: false },
            'testagnet.remote.configFile': { type: 'string', default: '~/.local/share/testagent' },
        });

        for (const key of [
            'testagnet.remote.backendApiUrl',
            'testagnet.remote.userName',
            'testagnet.remote.skipKnownHostsCheck',
            'testagnet.remote.historyLimit',
            'testagnet.remote.statusSyncInterval',
            'testagnet.remote.debug',
            'testagnet.remote.configFile',
        ]) {
            expect(properties[key].description).toBeTruthy();
        }
    });

    it('declares the container refresh command activation', () => {
        const commandIds = manifest.contributes.commands.map(({ command }) => command);

        expect(commandIds).toContain('openremotessh.refreshContainers');
        expect(manifest.activationEvents).toContain('onCommand:openremotessh.refreshContainers');
    });

    it('declares a webview sidebar and the disconnected create command', () => {
        expect(manifest.contributes.views.remote).toContainEqual({
            id: 'sshHosts',
            name: 'TestAgent Cloud',
            group: 'targets@1',
            type: 'webview',
            remoteName: 'ssh-remote',
        });
        expect(manifest.contributes.commands.map(({ command }) => command)).toContain('openremotessh.createContainer');
        expect(manifest.activationEvents).toContain('onCommand:openremotessh.createContainer');
        expect(manifest.contributes.menus['statusBar/remoteIndicator']).toContainEqual(expect.objectContaining({
            command: 'openremotessh.createContainer',
            when: 'remoteConnectionState == disconnected',
        }));
    });
});
