import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import fse from '@zokugun/fs-extra-plus/sync';
import { xtry } from '@zokugun/xtry/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import SSHConnection from '../src/ssh/sshConnection';
import SSHDestination from '../src/ssh/sshDestination';
import { RemoteSSHResolver, SSHConfiguration, getRemoteAuthority } from './rewires/remote';
import { Log } from './mocks/logger';
import type { Log as SourceLog } from '../src/common/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';
import { prepareAlpineServerRuntime, prepareServerPath } from './utils/prepare-server';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(TEST_DIRECTORY, 'fixtures', 'default');
const serverSetup = fse.readFile(path.resolve(TEST_DIRECTORY, '../src/scripts/server-setup.sh'), 'utf8');
if (serverSetup.fails) {
  throw serverSetup.error;
}
const SERVER_SETUP = serverSetup.value;

type ClientOptions = {
  files: Record<string, string>;
  /** When set, the hosts the SSH config is expected to declare. */
  hosts?: string[];
  /** When set, add ContainerId-backed aliases and resolve them through the real resolver. */
  containerAliases?: string[];
  /** When set, resolve an alias whose ContainerId endpoint must be rejected. */
  invalidContainerAlias?: string;
};

type ServerOptions = {
  image: string;
  username: string;
  password: string;
  removeServer?: boolean;
};

const files = fse.walk(ROOT, {
  absolute: true,
  onlyFiles: true,
  collect: true,
  filter: (item) => item.path.endsWith('.yml'),
});

if (files.fails) {
  throw files.error;
}

for (const file of files.value) {
  const name = fse.leafName(file.path, 1);
  const content = fse.readFile(file.path, 'utf8');
  if (content.fails) {
    throw content.error;
  }

  const document = xtry(() => YAML.parse(content.value) as unknown);
  if (document.fails) {
    throw document.error;
  }

  const { client, server } = document.value as { client: ClientOptions; server: ServerOptions };
  const containerName = `open-remote-ssh-test-${randomUUID()}`;

  describe.sequential(name, () => {
    let hostPort: number;

    beforeAll(async () => {
      vol.reset();

      if(!server.image.startsWith('local-')) {
        runDocker(['pull', server.image]);
      }

      runDocker(['rm', '-f', containerName], true);

      runDocker([
        'run',
        '--detach',
        '--rm',
        '--name',
        containerName,
        '--publish',
        '2222',
        '--env',
        `USER_NAME=${server.username}`,
        '--env',
        `USER_PASSWORD=${server.password}`,
        '--env',
        'PASSWORD_ACCESS=true',
        '--env',
        'SUDO_ACCESS=false',
        '--env',
        'LOG_STDOUT=true',
        server.image,
      ]);

      hostPort = getMappedPort(containerName);

      await waitForSSHReady(server.username, server.password, hostPort, 60_000);
      if (server.image === 'local-alpine-bash') {
        prepareAlpineServerRuntime(containerName, server.username);
      }
    }, 120_000);

    afterAll(() => {
      runDocker(['rm', '-f', containerName], true);
    });

    it(`test-${name}`, async () => {
      const fixtureFiles = { ...client.files };
      const sshConfig = client.files['/etc/ssh/ssh_config'];
      const includedSSHConfig = client.files['/etc/ssh/config.d/hosts'];
      if (sshConfig) {
        fixtureFiles['/etc/ssh/ssh_config'] = sshConfig.replace(/(Port\s+)2222\b/g, `$1${hostPort}`);
      }
      if (includedSSHConfig) {
        fixtureFiles['/etc/ssh/config.d/hosts'] = includedSSHConfig.replace(/(Port\s+)2222\b/g, `$1${hostPort}`);
      }
      const containerAliases = [
        ...(client.containerAliases ?? []),
        ...(client.invalidContainerAlias ? [client.invalidContainerAlias] : []),
      ];
      if (containerAliases.length) {
        const containerConfig = containerAliases.map((alias, index) => {
          const invalid = alias === client.invalidContainerAlias;
          return [
            `Host ${formatFixtureHost(alias)}`,
            `  HostName ${invalid ? 'example.com' : '127.0.0.1'}`,
            '  Port 2222',
            `  User ${server.username}`,
            `  Password ${server.password}`,
            `  ContainerId fixture-container-${index}`,
          ].join('\n');
        }).join('\n\n');
        fixtureFiles['/etc/ssh/ssh_config'] = `${fixtureFiles['/etc/ssh/ssh_config'] ?? ''}\n\n${containerConfig}\n`;
      }
      if (client.hosts && sshConfig && includedSSHConfig) {
        const defaultSSHConfigPath = path.resolve(os.homedir(), '.ssh', 'config');
        fixtureFiles[defaultSSHConfigPath] = sshConfig.replace(/(Port\s+)2222\b/g, `$1${hostPort}`);
        fixtureFiles[path.join(path.dirname(defaultSSHConfigPath), 'config.d', 'hosts')] = includedSSHConfig;
      }
      for (const filePath of Object.keys(fixtureFiles)) {
        fixtureFiles[filePath] = fixtureFiles[filePath].replace(/\b2222\b/g, String(hostPort));
      }

      vol.fromJSON({
        ...fixtureFiles,
        '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
      });
      vscode.setConfigurationValue('tscode.remote', 'configFile', '/etc/ssh/ssh_config');
      vscode.window.setPassword(server.password);

      if (client.hosts) {
        const config = await SSHConfiguration.loadFromFS();

        expect(config.getAllConfiguredHosts()).to.eql(client.hosts);
      }

      if (server.removeServer) {
        const connection = new SSHConnection({
          host: '127.0.0.1',
          port: hostPort,
          username: server.username,
          password: server.password,
          reconnect: false,
          readyTimeout: 10000,
          strictVendor: false,
        });

        try {
          await connection.exec('rm -rf "$HOME/.vscodium-server"');
        } finally {
          await connection.close();
        }
      } else {
        const connection = new SSHConnection({
          host: '127.0.0.1',
          port: hostPort,
          username: server.username,
          password: server.password,
          reconnect: false,
          readyTimeout: 10000,
          strictVendor: false,
        });

        try {
          await connection.connect();
          await prepareServerPath(connection);
        } finally {
          await connection.close();
        }
      }

      const logger = new Log('Remote - SSH') as unknown as SourceLog;
      const extContext = new vscode.ExtensionContext() as unknown as import('vscode').ExtensionContext;
      const remoteSSHResolver = new RemoteSSHResolver(extContext, logger);
      try {
        const remoteContext = new vscode.RemoteAuthorityResolverContext();
        const authority = getRemoteAuthority('test');
        const resultPromise = remoteSSHResolver.resolve(authority, remoteContext);

        if (server.removeServer) {
          await expect(resultPromise).rejects.toThrow('Remote server script not found or empty');
          return;
        }

        const result = await resultPromise;

        expect(result).toBeDefined();
        if (!('host' in result)) {
          throw new Error('Expected a resolved authority');
        }
        expect(result.host).to.eql('127.0.0.1');

        for (const alias of client.containerAliases ?? []) {
          const aliasResolver = new RemoteSSHResolver(extContext, logger);
          try {
            const aliasResult = await aliasResolver.resolve(
              getRemoteAuthority(new SSHDestination(alias).toEncodedString()),
              new vscode.RemoteAuthorityResolverContext(),
            );

            expect(aliasResult).toBeDefined();
            if (!('host' in aliasResult)) {
              throw new Error('Expected a resolved container authority');
            }
            expect(aliasResult.host).to.eql('127.0.0.1');
          } finally {
            aliasResolver.dispose();
          }
        }

        if (client.invalidContainerAlias) {
          const invalidResolver = new RemoteSSHResolver(extContext, logger);
          try {
            await expect(invalidResolver.resolve(
              getRemoteAuthority(new SSHDestination(client.invalidContainerAlias).toEncodedString()),
              new vscode.RemoteAuthorityResolverContext(),
            )).rejects.toThrow('endpoint 无效，必须是 IP:Port');
          } finally {
            invalidResolver.dispose();
          }
        }
      } finally {
        remoteSSHResolver.dispose();
      }
    }, 60_000);
  });
}

function formatFixtureHost(host: string): string {
  return /\s/.test(host) ? `"${host}"` : host;
}
