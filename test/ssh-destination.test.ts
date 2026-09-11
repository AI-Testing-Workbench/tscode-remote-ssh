import { describe, expect, it } from 'vitest';
import SSHDestination from '../src/ssh/sshDestination';

describe('SSHDestination', () => {
    it('round-trips aliases containing slash and spaces through an authority', () => {
        for (const hostname of ['alice/repo', 'TestAgent Cloud Service']) {
            const encoded = new SSHDestination(hostname).toEncodedString();

            expect(encoded).toMatch(/^[0-9a-f]+$/);
            expect(SSHDestination.parseEncoded(encoded)).toMatchObject({ hostname });
        }
    });

    it('preserves the existing compact encoding for ordinary hosts', () => {
        expect(new SSHDestination('dev').toEncodedString()).toBe('dev');
        expect(new SSHDestination('Dev').toEncodedString()).toBe('\\x44ev');
    });
});
