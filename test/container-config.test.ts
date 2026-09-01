import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import SSHConfig from 'ssh-config';
import {
    CONTAINER_ID_DIRECTIVE,
    ContainerConfig,
    getContainerConfigEntries,
    IGNORE_UNKNOWN_VALUE,
} from '../src/containerConfig';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    while (temporaryDirectories.length) {
        const directory = temporaryDirectories.pop();
        if (directory) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
});

describe('ContainerConfig', () => {
    it('creates a missing file, adds a container block, and writes skip settings', async () => {
        const store = await createStore();
        const document = await store.read();

        expect(document.originalText).toBe('');
        expect(store.upsertContainer(document.config, {
            containerId: 'container-1',
            host: 'alice/repo',
            hostName: '10.0.0.1',
            port: 22,
        }, { skipKnownHostsCheck: true })).toBe(true);
        expect(await store.write(document)).toBe(true);

        const text = await fs.readFile(store.filePath, 'utf8');
        expect(text).toContain('Host alice/repo');
        expect(text).toContain('HostName 10.0.0.1');
        expect(text).toContain('Port 22');
        expect(text).toContain(`${CONTAINER_ID_DIRECTIVE} container-1`);
        expect(text).toContain(`IgnoreUnknown ${IGNORE_UNKNOWN_VALUE}`);
        expect(text).toContain('StrictHostKeyChecking no');
        expect(text.indexOf('IgnoreUnknown')).toBeLessThan(text.indexOf('ContainerId'));
        expect(text.indexOf('StrictHostKeyChecking')).toBeLessThan(text.indexOf('ContainerId'));
        expect(store.list(SSHConfig.parse(text))).toEqual([{
            containerId: 'container-1',
            host: 'alice/repo',
            hostName: '10.0.0.1',
            port: 22,
        }]);
    });

    it('preserves ordinary hosts, includes, comments, whitespace, and unknown directives', async () => {
        const store = await createStore();
        const initial = [
            '# keep this comment',
            'Include ~/.ssh/extra',
            '',
            'Host ordinary',
            '  HostName ordinary.example.com',
            '  UnknownOption preserved',
            '',
            'Host 10.0.0.2',
            '\tcontainerid container-2',
            '\tIgnoreUnknown ExistingOption',
            '',
        ].join('\n');
        await fs.writeFile(store.filePath, initial, 'utf8');

        const document = await store.read();
        expect(getContainerConfigEntries(document.config)).toEqual([{
            containerId: 'container-2',
            host: '10.0.0.2',
        }]);
        expect(store.setExpiresAt(document.config, 'container-2', '2026-09-01T00:00:00+08:00')).toBe(true);
        expect(await store.write(document)).toBe(true);

        const text = await fs.readFile(store.filePath, 'utf8');
        expect(text).toContain('# keep this comment');
        expect(text).toContain('Include ~/.ssh/extra');
        expect(text).toContain('Host ordinary');
        expect(text).toContain('UnknownOption preserved');
        expect(text).toContain('IgnoreUnknown ExistingOption,ContainerId,ExpiresAt');
        expect(text).toContain('containerid container-2');
        expect(text).toContain('ExpiresAt 2026-09-01T00:00:00+08:00');
    });

    it('recognizes custom directives case-insensitively and keeps repeated writes idempotent', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { containerId: 'container-3', host: '10.0.0.3' });
        expect(await store.write(document)).toBe(true);

        const reloaded = await store.read();
        const section = reloaded.config.find(line => line.type === SSHConfig.DIRECTIVE && 'config' in line) as { config: SSHConfig };
        const containerId = section.config.find(line => line.type === SSHConfig.DIRECTIVE && /^containerid$/i.test(line.param));
        if (containerId && containerId.type === SSHConfig.DIRECTIVE) {
            containerId.param = 'cOnTaInErId';
        }
        const expiresAt = section.config.find(line => line.type === SSHConfig.DIRECTIVE && /^expiresat$/i.test(line.param));
        if (!expiresAt) {
            section.config.push({
                type: SSHConfig.DIRECTIVE,
                param: 'eXpIrEsAt',
                separator: ' ',
                value: '2026-09-01T00:00:00+08:00',
                before: '\t',
                after: '\n',
            });
        }
        await store.write(reloaded);

        const normalized = await store.read();
        expect(store.upsertContainer(normalized.config, {
            containerId: 'container-3',
            host: '10.0.0.3',
        })).toBe(true);
        expect(await store.write(normalized)).toBe(true);
        const stable = await store.read();
        expect(store.upsertContainer(stable.config, {
            containerId: 'container-3',
            host: '10.0.0.3',
        })).toBe(false);
        expect(await store.write(stable)).toBe(false);
    });

    it('adds, removes, and deletes expiration and container blocks without touching ordinary hosts', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { containerId: 'container-a', host: '10.0.0.4' });
        store.upsertContainer(document.config, { containerId: 'container-b', host: '10.0.0.5' });
        document.config.push(SSHConfig.parse('Host ordinary\n\tHostName ordinary.example.com\n')[0]);

        expect(store.setExpiresAt(document.config, 'container-a', '2026-09-01T00:00:00+08:00')).toBe(true);
        expect(store.removeExpiresAt(document.config, 'container-a')).toBe(true);
        expect(store.removeContainer(document.config, 'container-a')).toBe(true);
        expect(store.removeContainer(document.config, 'missing')).toBe(false);

        const entries = store.list(document.config);
        expect(entries).toEqual([{ containerId: 'container-b', host: '10.0.0.5' }]);
        expect(document.config.some(line => line.type === SSHConfig.DIRECTIVE && 'config' in line && line.value === 'ordinary')).toBe(true);
    });

    it('does not add or remove known-host settings when disabled', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { containerId: 'container-6', host: '10.0.0.6' }, { skipKnownHostsCheck: false });
        expect(SSHConfig.stringify(document.config)).not.toContain('StrictHostKeyChecking');

        const existing = SSHConfig.parse('Host 10.0.0.7\n\tStrictHostKeyChecking yes\n\tContainerId container-7\n');
        expect(store.setSkipKnownHostsCheck(existing, false)).toBe(false);
        expect(SSHConfig.stringify(existing)).toContain('StrictHostKeyChecking yes');
    });
});

async function createStore(): Promise<ContainerConfig> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-container-config-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'nested', 'testagent');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return new ContainerConfig(filePath);
}
