import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type ExtensionManifest = {
    contributes: {
        commands: Array<{ command: string }>;
        menus: Record<string, Array<{ command: string }>>;
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
});
