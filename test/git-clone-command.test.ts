import { describe, expect, it } from 'vitest';
import { GIT_CLONE_COMMAND } from '../src/ssh/gitCloneCommand';

describe('Git clone command', () => {
    it('redirects script stdout and stderr to the container log descriptors', () => {
        expect(GIT_CLONE_COMMAND).toBe('exec /root/.git-clone.sh >/proc/1/fd/1 2>/proc/1/fd/2');
    });
});
