import { spawnSync } from 'child_process';

const DOCKER_COMMAND_TIMEOUT_MS = 120_000;

export function runDocker(args: string[], allowFailure = false, timeoutMs = DOCKER_COMMAND_TIMEOUT_MS): string {
    // console.log(`docker ${args.join(' ')}`);

    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0 && !allowFailure) {
        throw new Error(`docker ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }

    if (result.status === null) {
        throw new Error(`docker ${args.join(' ')} timed out after ${timeoutMs}ms`);
    }

    return (result.stdout || '').trim();
}
