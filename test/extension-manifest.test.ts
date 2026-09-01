import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type ExtensionManifest = {
    contributes: {
        commands: Array<{ command: string }>;
        menus: Record<string, Array<{ command: string }>>;
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
            'testagnet.remote.skipKnownHostsCheck': { type: 'boolean', default: true },
            'testagnet.remote.historyLimit': { type: 'integer', default: 5 },
            'testagnet.remote.statusSyncInterval': { type: 'number', default: 5 },
        });

        for (const key of [
            'testagnet.remote.backendApiUrl',
            'testagnet.remote.skipKnownHostsCheck',
            'testagnet.remote.historyLimit',
            'testagnet.remote.statusSyncInterval',
        ]) {
            expect(properties[key].description).toBeTruthy();
        }
    });
});
