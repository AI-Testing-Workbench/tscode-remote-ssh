import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import fse from '@zokugun/fs-extra-plus/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import SSHConnection from '../src/ssh/sshConnection';
import { RemoteSSHResolver, getRemoteAuthority } from './rewires/remote';
import { Log } from './mocks/logger';
import type { Log as SourceLog } from '../src/common/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';
import { prepareServerPath } from './utils/prepare-server';

const SERVER_SETUP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/scripts/server-setup.sh');
const serverSetup = fse.readFile(SERVER_SETUP_PATH, 'utf8');
if (serverSetup.fails) {
  throw serverSetup.error;
}
const SERVER_SETUP = serverSetup.value;

const PRODUCT_JSON = JSON.stringify({
  nameShort: 'VSCodium',
  nameLong: 'VSCodium',
  applicationName: 'codium',
  quality: 'stable',
  commit: 'tscode',
  version: '1.126.04524',
  serverApplicationName: 'codium-server',
  serverDataFolderName: '.vscodium-server',
});

const IMAGE = 'local-ubuntu-bash';
const USERNAME = 'openremotessh';
const PASSWORD = 'openremotessh';

const containerName = `open-remote-ssh-test-${randomUUID()}`;

let authSock: string;
let agentPid: string | undefined;
let hostPort: number;

beforeAll(async () => {
  vol.reset();

  if (process.platform === 'win32') {
    authSock = process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
  } else {
    const agentOutput = execFileSync('ssh-agent', ['-s'], { encoding: 'utf8' });
    const socketMatch = /SSH_AUTH_SOCK=([^;]+);/.exec(agentOutput);
    const pidMatch = /SSH_AGENT_PID=(\d+);/.exec(agentOutput);
    agentPid = pidMatch?.[1];
    if (!socketMatch || !pidMatch) {
        throw new Error('Unable to parse ssh-agent output');
    }

    authSock = socketMatch[1];
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
    `USER_NAME=${USERNAME}`,
    '--env',
    `USER_PASSWORD=${PASSWORD}`,
    '--env',
    'PASSWORD_ACCESS=true',
    '--env',
    'SUDO_ACCESS=false',
    '--env',
    'LOG_STDOUT=true',
    IMAGE,
  ]);

  hostPort = getMappedPort(containerName);

  await waitForSSHReady(USERNAME, PASSWORD, hostPort, 60_000);
}, 120_000);

afterAll(() => {
  try {
    runDocker(['rm', '-f', containerName], true);
  } finally {
    if (agentPid) {
      execFileSync('ssh-agent', ['-k'], { env: { ...process.env, SSH_AGENT_PID: agentPid, SSH_AUTH_SOCK: authSock } });
    }
  }
});

it('forwards the agent through a socket that stays alive', async () => {
  vol.fromJSON({
    '/etc/ssh/ssh_config': [
      'Host test',
      '  HostName 127.0.0.1',
      `  Port ${hostPort}`,
      `  User ${USERNAME}`,
      `  Password ${PASSWORD}`,
      '  ForwardAgent yes',
      `  IdentityAgent ${authSock}`,
    ].join('\n'),
    '/bin/vscodium/app/product.json': PRODUCT_JSON,
    '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
  });
  vscode.setConfigurationValue('tscode.remote', 'configFile', '/etc/ssh/ssh_config');

  vscode.window.setPassword(PASSWORD);

  const preparationConnection = new SSHConnection({
    host: '127.0.0.1',
    port: hostPort,
    username: USERNAME,
    password: PASSWORD,
    reconnect: false,
    readyTimeout: 10_000,
    strictVendor: false,
  });

  try {
    await preparationConnection.connect();
    await prepareServerPath(preparationConnection);
  } finally {
    await preparationConnection.close();
  }

  const logger = new Log('Remote - SSH') as unknown as SourceLog;
  const extContext = new vscode.ExtensionContext() as unknown as import('vscode').ExtensionContext;
  const remoteSSHResolver = new RemoteSSHResolver(extContext, logger);
  try {
    const remoteContext = new vscode.RemoteAuthorityResolverContext();
    const authority = getRemoteAuthority('test');
    const result = await remoteSSHResolver.resolve(authority, remoteContext);

    expect(result).toBeDefined();
    if (!('host' in result)) {
      throw new Error('Expected a resolved authority');
    }
    expect(result.host).toBe('127.0.0.1');

    const remoteAuthSock = result.extensionHostEnv?.SSH_AUTH_SOCK;
    expect(remoteAuthSock, 'SSH_AUTH_SOCK should be exported to the extension host').toBeTypeOf('string');
    expect(remoteAuthSock!.startsWith('/'), 'forwarded SSH_AUTH_SOCK should be an absolute path').toBe(true);

    expect(extContext.environmentVariableCollection.replace).toHaveBeenCalledWith('SSH_AUTH_SOCK', remoteAuthSock);

    const probe = new SSHConnection({
      host: '127.0.0.1',
      port: hostPort,
      username: USERNAME,
      password: PASSWORD,
      reconnect: false,
      readyTimeout: 10_000,
      strictVendor: false,
    });

    try {
      const { stdout } = await probe.exec(`test -S "${remoteAuthSock}" && echo LIVE || echo DEAD`);
      expect(stdout.trim(), 'forwarded socket should still exist after resolve').toContain('LIVE');
    } finally {
      await probe.close();
    }
  } finally {
    remoteSSHResolver.dispose();
  }
}, 60_000);
