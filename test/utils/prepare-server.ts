import type SSHConnection from '../../src/ssh/sshConnection';
import { DISTRO_COMMIT } from '../../src/serverConfig';
import { runDocker } from './run-docker';

export function prepareAlpineServerRuntime(containerName: string, username: string): void {
    const command = [
        'set -eu',
        'broken_node=0',
        `for root in /etc/skel /home/${username}; do`,
        '  for candidate in "$root"/.vscodium-server/bin/*/node; do',
        '    if [ -f "$candidate" ] && ! "$candidate" --version >/dev/null 2>&1; then',
        '      broken_node=1',
        '    fi',
        '  done',
        'done',
        'if [ "$broken_node" -eq 1 ]; then',
        '  apk add --no-cache nodejs >/dev/null',
        `  for root in /etc/skel /home/${username}; do`,
        '    for candidate in "$root"/.vscodium-server/bin/*/node; do',
        '      if [ -f "$candidate" ] && ! "$candidate" --version >/dev/null 2>&1; then',
        '        mv "$candidate" "$candidate.glibc"',
        '        ln -s /usr/bin/node "$candidate"',
        '      fi',
        '    done',
        '  done',
        'fi',
    ].join('\n');

    runDocker(['exec', '--user', '0', containerName, 'sh', '-c', command]);
}

export async function prepareServerPath(connection: SSHConnection): Promise<void> {
    const serverRoot = '$HOME/.vscodium-server';
    const fixedServerPath = `${serverRoot}/bin/${DISTRO_COMMIT}`;
    const command = [
        `if [ ! -s "${fixedServerPath}/bin/codium-server" ]; then`,
        `  rm -rf "${fixedServerPath}"`,
        `  for candidate in "${serverRoot}"/bin/*/bin/codium-server; do`,
        '    if [ -s "$candidate" ]; then',
        '      candidate_dir="$(dirname "$(dirname "$candidate")")"',
        `      ln -s "$candidate_dir" "${fixedServerPath}"`,
        '      break',
        '    fi',
        '  done',
        'fi',
    ].join('\n');

    const encodedCommand = Buffer.from(command).toString('base64');
    await connection.exec(`echo ${encodedCommand} | base64 -d | bash -l`);
}
