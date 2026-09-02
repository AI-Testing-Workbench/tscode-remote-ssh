import { isIP } from 'node:net';

export interface ParsedContainerEndpoint {
    host: string;
    port: number;
    debugProxy?: string;
}

export interface InvalidContainerEndpoint {
    containerId: string;
    endpoint: string | null | undefined;
}

export class InvalidContainerEndpointError extends Error {
    constructor(
        public readonly containerId: string,
        public readonly endpoint: string | null | undefined,
    ) {
        super(`服务 "${containerId}" 的 endpoint 无效，必须是 IP:Port`);
        this.name = 'InvalidContainerEndpointError';
    }
}

export class DebugEnvironmentPreparationCancelledError extends Error {
    constructor(public readonly containerId: string) {
        super(`已取消服务 "${containerId}" 的调试确认`);
        this.name = 'DebugEnvironmentPreparationCancelledError';
    }
}

export const DEBUG_ENVIRONMENT_CONFIRMATION = '继续';

export type DebugEnvironmentPrompt = (
    message: string,
    options: { modal: true },
    ...items: string[]
) => Thenable<string | undefined>;

export function createDebugEnvironmentConfirmer(
    prompt: DebugEnvironmentPrompt,
): (containerId: string) => Promise<void> {
    const confirmations = new Map<string, Promise<void>>();
    return containerId => {
        const existingConfirmation = confirmations.get(containerId);
        if (existingConfirmation) {
            return existingConfirmation;
        }

        const confirmation = confirmDebugEnvironment(prompt, containerId).catch(error => {
            confirmations.delete(containerId);
            throw error;
        });
        confirmations.set(containerId, confirmation);
        return confirmation;
    };
}

export async function confirmDebugEnvironment(
    prompt: DebugEnvironmentPrompt,
    containerId: string,
): Promise<void> {
    const result = await prompt(
        `当前处于调试模式，\n请完成容器环境准备后继续。`,
        { modal: true },
        DEBUG_ENVIRONMENT_CONFIRMATION,
        '取消',
    );
    if (result !== DEBUG_ENVIRONMENT_CONFIRMATION) {
        throw new DebugEnvironmentPreparationCancelledError(containerId);
    }
}

export function parseContainerEndpoint(
    endpoint: string | null | undefined,
    options: { allowDebugProxy?: boolean } = {},
): ParsedContainerEndpoint | undefined {
    if (typeof endpoint !== 'string') {
        return undefined;
    }

    const value = endpoint.trim();
    const debugProxyMatch = value.match(/^(.+?)\/proxy\/([^/\s]+)$/);
    if (debugProxyMatch && !options.allowDebugProxy) {
        return undefined;
    }
    const endpointValue = debugProxyMatch ? debugProxyMatch[1] : value;
    const debugProxy = debugProxyMatch?.[2];
    const ipv4Match = endpointValue.match(/^([^:\s]+):(\d+)$/);
    const ipv6Match = endpointValue.match(/^\[([^\]]+)\]:(\d+)$/);
    const host = ipv4Match?.[1] ?? ipv6Match?.[1];
    const portText = ipv4Match?.[2] ?? ipv6Match?.[2];
    if (!host || !portText || (ipv4Match && isIP(host) !== 4) || (ipv6Match && isIP(host) !== 6)) {
        return undefined;
    }

    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return undefined;
    }
    return {
        host,
        port,
        ...(debugProxy ? { debugProxy } : {}),
    };
}

export function formatContainerEndpoint(host: string, port: string | number | undefined): string {
    const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
    return `${formattedHost}:${port ?? ''}`;
}
