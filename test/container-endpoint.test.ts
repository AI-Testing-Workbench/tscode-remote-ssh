import { describe, expect, it, vi } from 'vitest';
import {
    confirmDebugEnvironment,
    createDebugEnvironmentConfirmer,
    DEBUG_ENVIRONMENT_CONFIRMATION,
    DebugEnvironmentPreparationCancelledError,
    formatContainerEndpoint,
    parseContainerEndpoint,
} from '../src/containerEndpoint';

describe('container endpoint', () => {
    it('accepts IPv4 and bracketed IPv6 endpoints with valid ports', () => {
        expect(parseContainerEndpoint(' 10.0.0.1:2222 ')).toEqual({ host: '10.0.0.1', port: 2222 });
        expect(parseContainerEndpoint('[2001:db8::1]:22')).toEqual({ host: '2001:db8::1', port: 22 });
        expect(formatContainerEndpoint('2001:db8::1', 22)).toBe('[2001:db8::1]:22');
    });

    it('accepts the proxy suffix only when debug parsing is enabled', () => {
        expect(parseContainerEndpoint('10.0.0.1:2222/proxy/XX')).toBeUndefined();
        expect(parseContainerEndpoint('10.0.0.1:2222/proxy/XX', { allowDebugProxy: true })).toEqual({
            host: '10.0.0.1',
            port: 2222,
            debugProxy: 'XX',
        });
        expect(parseContainerEndpoint('[::1]:22/proxy/dev', { allowDebugProxy: true })).toEqual({
            host: '::1',
            port: 22,
            debugProxy: 'dev',
        });
    });

    it('rejects hostnames, missing ports, malformed IPs, and invalid port ranges', () => {
        for (const endpoint of [
            'example.com:22',
            '10.0.0.1',
            '10.0.0.1:0',
            '10.0.0.1:65536',
            '10.0.0.1:abc',
            'ssh://10.0.0.1:22',
            '2001:db8::1:22',
            '10.0.0.1:22/proxy/',
            '10.0.0.1:22/other/XX',
            null,
            undefined,
        ]) {
            expect(parseContainerEndpoint(endpoint)).toBeUndefined();
        }
    });

    it('requires explicit developer environment confirmation before debug connection', async () => {
        const prompt = vi.fn(async () => DEBUG_ENVIRONMENT_CONFIRMATION);

        await expect(confirmDebugEnvironment(prompt, 'container-1')).resolves.toBeUndefined();
        expect(prompt).toHaveBeenCalledWith(
            '当前处于调试模式，\n请完成 TestAgent Cloud 服务环境准备后继续。',
            { modal: true },
            DEBUG_ENVIRONMENT_CONFIRMATION,
            '取消',
        );

        const cancelPrompt = vi.fn(async () => '取消');
        await expect(confirmDebugEnvironment(cancelPrompt, 'container-2'))
            .rejects.toBeInstanceOf(DebugEnvironmentPreparationCancelledError);
    });

    it('shares a debug confirmation across repeated resolver calls', async () => {
        const prompt = vi.fn(async () => DEBUG_ENVIRONMENT_CONFIRMATION);
        const confirmOnce = createDebugEnvironmentConfirmer(prompt);

        await Promise.all([confirmOnce('container-1'), confirmOnce('container-1')]);
        await confirmOnce('container-1');
        await confirmOnce('container-2');

        expect(prompt).toHaveBeenCalledTimes(2);
    });

    it('allows a debug confirmation retry after cancellation', async () => {
        const prompt = vi.fn()
            .mockResolvedValueOnce('取消')
            .mockResolvedValueOnce(DEBUG_ENVIRONMENT_CONFIRMATION);
        const confirmOnce = createDebugEnvironmentConfirmer(prompt);

        await expect(confirmOnce('container-1')).rejects.toBeInstanceOf(DebugEnvironmentPreparationCancelledError);
        await expect(confirmOnce('container-1')).resolves.toBeUndefined();
        expect(prompt).toHaveBeenCalledTimes(2);
    });
});
