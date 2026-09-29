import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SSHConfig from 'ssh-config';
import {
    LEGACY_CONTAINER_ID_DIRECTIVE,
    SERVICE_ID_DIRECTIVE,
    ContainerConfig,
    ContainerConfigFileSystem,
    getContainerConfigEntries,
    getConfiguredContainerConfigPath,
    getLegacyContainerConfigPath,
    IGNORE_UNKNOWN_VALUE,
    NULL_KNOWN_HOSTS_FILE,
    USER_KNOWN_HOSTS_FILE_DIRECTIVE,
} from '../src/containerConfig';
import * as vscode from './mocks/vscode';

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
    beforeEach(() => {
        vscode.resetConfiguration();
    });

    it('creates a missing file, adds a container block, and writes skip settings', async () => {
        const store = await createStore();
        const document = await store.read();

        expect(document.originalText).toBe('');
        expect(store.upsertContainer(document.config, {
            serviceId: 'container-1',
            host: 'alice/repo',
            hostName: '10.0.0.1',
            port: 22,
        }, { skipKnownHostsCheck: true, userName: 'root' })).toBe(true);
        expect(await store.write(document)).toBe(true);

        const text = await fs.readFile(store.filePath, 'utf8');
        expect(text).toContain('Host alice/repo');
        expect(text).toContain('HostName 10.0.0.1');
        expect(text).toContain('Name alice/repo');
        expect(text).toContain('User root');
        expect(text).toContain('Port 22');
        expect(text).toContain(`${SERVICE_ID_DIRECTIVE} container-1`);
        expect(text).toContain(`IgnoreUnknown ${IGNORE_UNKNOWN_VALUE}`);
        expect(text).toContain('StrictHostKeyChecking no');
        expect(text).toContain(`${USER_KNOWN_HOSTS_FILE_DIRECTIVE} ${NULL_KNOWN_HOSTS_FILE}`);
        expect(getServiceFields(text)).toEqual([
            'HostName 10.0.0.1',
            'Name alice/repo',
            'User root',
            'Port 22',
            'StrictHostKeyChecking no',
            'UserKnownHostsFile /dev/null',
            'IgnoreUnknown ServiceId,ExpiresAt,Name',
            'ServiceId container-1',
        ]);
        expect(text.indexOf('IgnoreUnknown')).toBeLessThan(text.indexOf('ServiceId'));
        expect(text.indexOf('StrictHostKeyChecking')).toBeLessThan(text.indexOf('ServiceId'));
        expect(store.list(SSHConfig.parse(text))).toEqual([{
            serviceId: 'container-1',
            host: 'alice/repo',
            name: 'alice/repo',
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
            '\tserviceid container-2',
            '\tIgnoreUnknown ExistingOption',
            '',
        ].join('\n');
        await fs.writeFile(store.filePath, initial, 'utf8');

        const document = await store.read();
        expect(getContainerConfigEntries(document.config)).toEqual([{
            serviceId: 'container-2',
            host: '10.0.0.2',
        }]);
        expect(store.setExpiresAt(document.config, 'container-2', '2026-09-01T00:00:00+08:00')).toBe(true);
        expect(await store.write(document)).toBe(true);

        const text = await fs.readFile(store.filePath, 'utf8');
        expect(text).toContain('# keep this comment');
        expect(text).toContain('Include ~/.ssh/extra');
        expect(text).toContain('Host ordinary');
        expect(text).toContain('UnknownOption preserved');
        expect(text).toContain('IgnoreUnknown ExistingOption,ServiceId,ExpiresAt,Name');
        expect(text).toContain('serviceid container-2');
        expect(text).toContain('ExpiresAt 2026-09-01T00:00:00+08:00');
    });

    it('recognizes custom directives case-insensitively and keeps repeated writes idempotent', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { serviceId: 'container-3', host: '10.0.0.3' });
        expect(await store.write(document)).toBe(true);

        const reloaded = await store.read();
        const section = reloaded.config.find(line => line.type === SSHConfig.DIRECTIVE && 'config' in line) as { config: SSHConfig };
        const serviceId = section.config.find(line => line.type === SSHConfig.DIRECTIVE && /^serviceid$/i.test(line.param));
        if (serviceId && serviceId.type === SSHConfig.DIRECTIVE) {
            serviceId.param = 'sErViCeId';
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
            serviceId: 'container-3',
            host: '10.0.0.3',
        })).toBe(true);
        expect(await store.write(normalized)).toBe(true);
        const stable = await store.read();
        expect(store.upsertContainer(stable.config, {
            serviceId: 'container-3',
            host: '10.0.0.3',
        })).toBe(false);
        expect(await store.write(stable)).toBe(false);
    });

    it('adds, removes, and deletes expiration and container blocks without touching ordinary hosts', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { serviceId: 'container-a', host: '10.0.0.4' });
        store.upsertContainer(document.config, { serviceId: 'container-b', host: '10.0.0.5' });
        document.config.push(SSHConfig.parse('Host ordinary\n\tHostName ordinary.example.com\n')[0]);

        expect(store.setExpiresAt(document.config, 'container-a', '2026-09-01T00:00:00+08:00')).toBe(true);
        expect(store.removeExpiresAt(document.config, 'container-a')).toBe(true);
        expect(store.removeContainer(document.config, 'container-a')).toBe(true);
        expect(store.removeContainer(document.config, 'missing')).toBe(false);

        const entries = store.list(document.config);
        expect(entries).toEqual([{ serviceId: 'container-b', host: '10.0.0.5', name: '10.0.0.5' }]);
        expect(document.config.some(line => line.type === SSHConfig.DIRECTIVE && 'config' in line && line.value === 'ordinary')).toBe(true);
    });

    it('normalizes known service fields in an existing block', async () => {
        const store = await createStore();
        const initial = [
            'Host test/test',
            '\tServiceId container-order',
            '\tExpiresAt 2026-09-02T00:47:16.734Z',
            '\tUserKnownHostsFile /dev/null',
            '\tStrictHostKeyChecking no',
            '\tPort 59194',
            '\tUser root',
            '\tHostName 127.0.0.1',
            '\tIgnoreUnknown ServiceId,ExpiresAt',
            '',
        ].join('\n');
        await fs.writeFile(store.filePath, initial, 'utf8');

        const document = await store.read();
        expect(store.upsertContainer(document.config, {
            serviceId: 'container-order',
            host: 'test/test',
            hostName: '127.0.0.1',
            port: 59194,
            expiresAt: '2026-09-02T00:47:16.734Z',
        }, { skipKnownHostsCheck: true, userName: 'root' })).toBe(true);
        expect(await store.write(document)).toBe(true);

        expect(getServiceFields(await fs.readFile(store.filePath, 'utf8'))).toEqual([
            'HostName 127.0.0.1',
            'Name test/test',
            'User root',
            'Port 59194',
            'StrictHostKeyChecking no',
            'UserKnownHostsFile /dev/null',
            'IgnoreUnknown ServiceId,ExpiresAt,Name',
            'ServiceId container-order',
            'ExpiresAt 2026-09-02T00:47:16.734Z',
        ]);
    });

    it('leaves service hosts unquoted when normalizing an existing block', async () => {
        const store = await createStore();
        const initial = [
            'Host 云端沙箱 Service',
            '\tServiceId container-spaced-host',
            '',
        ].join('\n');
        await fs.writeFile(store.filePath, initial, 'utf8');

        const document = await store.read();
        expect(store.list(document.config)).toEqual([{
            serviceId: 'container-spaced-host',
            host: '云端沙箱 Service',
        }]);
        store.upsertContainer(document.config, {
            serviceId: 'container-spaced-host',
            host: '云端沙箱 Service',
        });
        await store.write(document);

        const text = await fs.readFile(store.filePath, 'utf8');
        expect(text).not.toContain('"');
        expect(text).toContain('Host 云端沙箱 Service');
    });

    it('does not add or remove known-host settings when disabled', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { serviceId: 'container-6', host: '10.0.0.6' }, { skipKnownHostsCheck: false });
        expect(SSHConfig.stringify(document.config)).not.toContain('StrictHostKeyChecking');
        expect(SSHConfig.stringify(document.config)).not.toContain(USER_KNOWN_HOSTS_FILE_DIRECTIVE);

        const existing = SSHConfig.parse('Host 10.0.0.7\n\tStrictHostKeyChecking yes\n\tUserKnownHostsFile ~/.ssh/known_hosts\n\tServiceId service-7\n');
        expect(store.setSkipKnownHostsCheck(existing, false)).toBe(false);
        expect(SSHConfig.stringify(existing)).toContain('StrictHostKeyChecking yes');
        expect(SSHConfig.stringify(existing)).toContain('UserKnownHostsFile ~/.ssh/known_hosts');

        const enabled = SSHConfig.parse('Host 10.0.0.8\n\tServiceId service-8\n');
        expect(store.setSkipKnownHostsCheck(enabled, true)).toBe(true);
        expect(SSHConfig.stringify(enabled)).toContain('StrictHostKeyChecking no');
        expect(SSHConfig.stringify(enabled)).toContain(`${USER_KNOWN_HOSTS_FILE_DIRECTIVE} ${NULL_KNOWN_HOSTS_FILE}`);
    });

    it('moves the legacy config when the new file does not exist', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-migration-'));
        temporaryDirectories.push(directory);
        const legacyPath = path.join(directory, 'config');
        const newPath = path.join(directory, 'sandbox.config');
        const legacyText = [
            '# legacy service config',
            'Host legacy-service',
            '\tHostName 10.0.0.20',
            '\tContainerId legacy-1',
            '',
        ].join('\n');
        await fs.writeFile(legacyPath, legacyText, 'utf8');

        const store = new ContainerConfig(newPath, undefined, legacyPath);
        const document = await store.read();

        expect(document.originalText).toBe(legacyText);
        expect(getContainerConfigEntries(document.config)).toEqual([]);
        expect(document.originalText).toContain(`${LEGACY_CONTAINER_ID_DIRECTIVE} legacy-1`);
        expect(await fs.readFile(newPath, 'utf8')).toBe(legacyText);
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await store.read()).originalText).toBe(legacyText);
    });

    it('merges unique legacy sections and keeps current sections on conflicts', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-migration-'));
        temporaryDirectories.push(directory);
        const legacyPath = path.join(directory, 'config');
        const newPath = path.join(directory, 'sandbox.config');
        const currentText = [
            'User current-user',
            'Host shared-service',
            '\tHostName current.example.com',
            '\tServiceId current-service-1',
            '',
        ].join('\n');
        const legacyText = [
            'User legacy-user',
            'IdentityFile ~/.ssh/legacy-key',
            'Host shared-service legacy-alias',
            '\tHostName legacy.example.com',
            '\tContainerId legacy-duplicate',
            '',
            'Host legacy-service',
            '\tContainerId legacy-1',
            '',
        ].join('\n');
        await fs.writeFile(legacyPath, legacyText, 'utf8');
        await fs.writeFile(newPath, currentText, 'utf8');

        const store = new ContainerConfig(newPath, undefined, legacyPath);
        const document = await store.read();
        const migratedText = await fs.readFile(newPath, 'utf8');

        expect(document.originalText).toBe(migratedText);
        expect(store.list(document.config).map(entry => entry.serviceId)).toEqual(['current-service-1']);
        expect(migratedText).toContain('HostName current.example.com');
        expect(migratedText).toContain('Host legacy-alias');
        expect(migratedText).not.toContain('Host shared-service legacy-alias');
        expect(migratedText).toContain('HostName legacy.example.com');
        expect(migratedText).toContain(`${LEGACY_CONTAINER_ID_DIRECTIVE} legacy-1`);
        expect(migratedText).toContain('IdentityFile ~/.ssh/legacy-key');
        expect(migratedText.indexOf('User current-user')).toBeLessThan(migratedText.indexOf('User legacy-user'));
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the legacy file when writing the merged target fails', async () => {
        const legacyPath = '/legacy/config';
        const currentPath = '/active/sandbox.config';
        const files = new Map<string, string>([
            [legacyPath, 'Host legacy-service\n\tContainerId legacy-1\n'],
            [currentPath, 'Host current-service\n\tServiceId service-current-1\n'],
        ]);
        const fileSystem: ContainerConfigFileSystem = {
            mkdir: vi.fn(async () => undefined),
            readFile: vi.fn(async filePath => {
                const content = files.get(filePath);
                if (content !== undefined) {
                    return content;
                }
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }),
            writeFile: vi.fn(async (filePath, content) => {
                files.set(filePath, content);
            }),
            rename: vi.fn(async (oldPath, newFilePath) => {
                if (newFilePath === currentPath) {
                    throw Object.assign(new Error('write failed'), { code: 'EIO' });
                }
                const content = files.get(oldPath);
                if (content === undefined) {
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                }
                files.set(newFilePath, content);
                files.delete(oldPath);
            }),
            unlink: vi.fn(async filePath => {
                if (!files.delete(filePath)) {
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                }
            }),
        };

        await expect(new ContainerConfig(currentPath, fileSystem, legacyPath).read()).rejects.toMatchObject({ code: 'EIO' });
        expect(files.get(legacyPath)).toContain('legacy-1');
        expect(files.get(currentPath)).toContain('current-1');
    });

    it('restores the current file if an atomic replacement fails', async () => {
        const legacyPath = '/legacy/config';
        const currentPath = '/active/sandbox.config';
        const currentText = 'Host current-service\n\tServiceId service-current\n';
        const files = new Map<string, string>([
            [legacyPath, 'Host legacy-service\n\tContainerId legacy-1\n'],
            [currentPath, currentText],
        ]);
        let targetReplacementAttempts = 0;
        const fileSystem: ContainerConfigFileSystem = {
            mkdir: vi.fn(async () => undefined),
            readFile: vi.fn(async filePath => {
                const content = files.get(filePath);
                if (content !== undefined) {
                    return content;
                }
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }),
            writeFile: vi.fn(async (filePath, content) => {
                files.set(filePath, content);
            }),
            rename: vi.fn(async (oldPath, newFilePath) => {
                if (newFilePath === currentPath && !oldPath.includes('.backup-')) {
                    targetReplacementAttempts += 1;
                    throw Object.assign(new Error('replacement failed'), {
                        code: targetReplacementAttempts === 1 ? 'EPERM' : 'EIO',
                    });
                }
                const content = files.get(oldPath);
                if (content === undefined) {
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                }
                files.set(newFilePath, content);
                files.delete(oldPath);
            }),
            unlink: vi.fn(async filePath => {
                if (!files.delete(filePath)) {
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                }
            }),
        };

        await expect(new ContainerConfig(currentPath, fileSystem, legacyPath).read()).rejects.toMatchObject({ code: 'EIO' });
        expect(files.get(currentPath)).toBe(currentText);
        expect(files.get(legacyPath)).toContain('legacy-1');
        expect(Array.from(files.keys()).some(filePath => filePath.includes('.backup-'))).toBe(false);
    });

    it('resolves a configured legacy directory to its config file', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-directory-migration-'));
        temporaryDirectories.push(directory);
        const legacyDirectory = path.join(directory, 'legacy-config');
        const legacyPath = path.join(legacyDirectory, 'config');
        const currentPath = path.join(directory, 'active', 'sandbox.config');
        await fs.mkdir(legacyDirectory, { recursive: true });
        await fs.writeFile(legacyPath, 'Host legacy-service\n\tContainerId legacy-1\n', 'utf8');
        vscode.setConfigurationValue('tscode.remote', 'configFile', legacyDirectory);

        expect(getLegacyContainerConfigPath()).toBe(legacyPath);
        await new ContainerConfig(currentPath, undefined, getLegacyContainerConfigPath()).read();

        expect(await fs.readFile(currentPath, 'utf8')).toContain('ContainerId legacy-1');
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('never migrates or changes the ordinary SSH config path', async () => {
        const legacyPath = path.resolve(os.homedir(), '.ssh', 'config');
        const currentPath = '/active/sandbox.config';
        const originalSshConfig = 'Host ordinary\n\tHostName ordinary.example.com\n';
        const files = new Map<string, string>([[legacyPath, originalSshConfig]]);
        const fileSystem: ContainerConfigFileSystem = {
            mkdir: vi.fn(async () => undefined),
            readFile: vi.fn(async filePath => {
                const content = files.get(filePath);
                if (content !== undefined) {
                    return content;
                }
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }),
            writeFile: vi.fn(async (filePath, content) => {
                files.set(filePath, content);
            }),
            rename: vi.fn(async () => undefined),
            unlink: vi.fn(async filePath => {
                files.delete(filePath);
            }),
        };

        const document = await new ContainerConfig(currentPath, fileSystem, legacyPath).read();

        expect(document.originalText).toBe('');
        expect(files.get(legacyPath)).toBe(originalSshConfig);
        expect(files.get(currentPath)).toBe('');
        expect(fileSystem.rename).not.toHaveBeenCalled();
        expect(fileSystem.unlink).not.toHaveBeenCalled();
    });

    it('removes entire legacy ContainerId host sections idempotently', () => {
        const store = new ContainerConfig('/active/sandbox.config');
        const config = SSHConfig.parse([
            'Host old-service',
            `\t${LEGACY_CONTAINER_ID_DIRECTIVE} old-1`,
            '\tName old-service',
            '',
            'Host new-service',
            '\tServiceId service-1',
            '',
            'Host ordinary',
            '\tHostName ordinary.example.com',
            '',
        ].join('\n'));

        expect(store.removeLegacyContainerEntries(config)).toBe(true);
        const cleanedText = SSHConfig.stringify(config);
        expect(cleanedText).not.toContain('Host old-service');
        expect(cleanedText).not.toContain(`${LEGACY_CONTAINER_ID_DIRECTIVE} old-1`);
        expect(cleanedText).toContain('Host new-service');
        expect(cleanedText).toContain('ServiceId service-1');
        expect(cleanedText).toContain('Host ordinary');
        expect(store.removeLegacyContainerEntries(config)).toBe(false);
    });

    it('does not expose a legacy path when the old configFile setting is absent', () => {
        expect(getLegacyContainerConfigPath()).toBeUndefined();
    });

    it('removes the legacy configFile setting after migrating its configured file', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-setting-migration-'));
        temporaryDirectories.push(directory);
        const legacyPath = path.join(directory, 'config');
        const newPath = getConfiguredContainerConfigPath();
        const files = new Map<string, string>([[legacyPath, 'Host legacy-service\n\tContainerId legacy-1\n']]);
        vscode.setConfigurationValue('tscode.remote', 'configFile', legacyPath);
        const fileSystem: ContainerConfigFileSystem = {
            mkdir: vi.fn(async () => undefined),
            readFile: vi.fn(async filePath => {
                const content = files.get(filePath);
                if (content !== undefined) {
                    return content;
                }
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }),
            writeFile: vi.fn(async (filePath, content) => {
                files.set(filePath, content);
            }),
            rename: vi.fn(async (oldPath, newFilePath) => {
                const content = files.get(oldPath);
                if (content === undefined) {
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                }
                files.set(newFilePath, content);
                files.delete(oldPath);
            }),
            unlink: vi.fn(async filePath => {
                if (!files.delete(filePath)) {
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                }
            }),
        };

        const document = await new ContainerConfig(newPath, fileSystem).read();

        expect(getContainerConfigEntries(document.config)).toEqual([]);
        expect(files.has(legacyPath)).toBe(false);
        expect(files.has(newPath)).toBe(true);
        expect(getLegacyContainerConfigPath()).toBeUndefined();
    });

    it('atomically preserves the active file before clearing a missing legacy path setting', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-missing-setting-'));
        temporaryDirectories.push(directory);
        const legacyPath = path.join(directory, 'missing-config');
        const currentPath = getConfiguredContainerConfigPath();
        const currentText = 'Host active-service\n\tServiceId service-active\n';
        const files = new Map<string, string>([[currentPath, currentText]]);
        vscode.setConfigurationValue('tscode.remote', 'configFile', legacyPath);
        const fileSystem: ContainerConfigFileSystem = {
            mkdir: vi.fn(async () => undefined),
            readFile: vi.fn(async filePath => {
                const content = files.get(filePath);
                if (content !== undefined) {
                    return content;
                }
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }),
            writeFile: vi.fn(async (filePath, content) => {
                files.set(filePath, content);
            }),
            rename: vi.fn(async (oldPath, newFilePath) => {
                const content = files.get(oldPath);
                if (content === undefined) {
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                }
                files.set(newFilePath, content);
                files.delete(oldPath);
            }),
            unlink: vi.fn(async filePath => {
                if (!files.delete(filePath)) {
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                }
            }),
        };

        await new ContainerConfig(currentPath, fileSystem).read();

        expect(files.get(currentPath)).toBe(currentText);
        expect(fileSystem.rename).toHaveBeenCalledOnce();
        expect(getLegacyContainerConfigPath()).toBeUndefined();
    });

    it('keeps the missing legacy path setting when the active file write fails', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-missing-setting-failure-'));
        temporaryDirectories.push(directory);
        const legacyPath = path.join(directory, 'missing-config');
        const currentPath = getConfiguredContainerConfigPath();
        const files = new Map<string, string>([[currentPath, 'Host active-service\n\tServiceId service-active\n']]);
        vscode.setConfigurationValue('tscode.remote', 'configFile', legacyPath);
        const fileSystem: ContainerConfigFileSystem = {
            mkdir: vi.fn(async () => undefined),
            readFile: vi.fn(async filePath => {
                const content = files.get(filePath);
                if (content !== undefined) {
                    return content;
                }
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }),
            writeFile: vi.fn(async (filePath, content) => {
                files.set(filePath, content);
            }),
            rename: vi.fn(async () => {
                throw Object.assign(new Error('write failed'), { code: 'EIO' });
            }),
            unlink: vi.fn(async filePath => {
                files.delete(filePath);
            }),
        };

        await expect(new ContainerConfig(currentPath, fileSystem).read()).rejects.toMatchObject({ code: 'EIO' });
        expect(getLegacyContainerConfigPath()).toBe(legacyPath);
        expect(files.get(currentPath)).toContain('service-active');
    });
});

async function createStore(): Promise<ContainerConfig> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-container-config-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'nested', 'testagent');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return new ContainerConfig(filePath);
}

function getServiceFields(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('Host '));
}
