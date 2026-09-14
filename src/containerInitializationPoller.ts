import type { ContainerStatusResponse, GitCredentialSubmitRequest, GitStatus } from './api/models';
import type { GitRestApi, UserRestApi } from './api/restClient';
import { GitConfigReader } from './gitConfig';
import { promptForGitCredentials } from './gitCredentialPrompt';

export interface ContainerInitializationInput {
    containerId: string;
    serviceId: string;
    operatorUserId: string;
    statusReader?: Pick<UserRestApi, 'getContainer'>;
    signal?: AbortSignal;
    /** Kept for the creation boundary; endpoint validation belongs after initialization. */
    endpoint?: string | null;
}

export interface GitCredentialPromptContext {
    containerId: string;
    serviceId: string;
    operatorUserId: string;
    gitStatus: Extract<GitStatus, 'credential_required' | 'credential_rejected'>;
}

export interface ContainerInitializationResult {
    containerId: string;
    serviceId: string;
    operatorUserId: string;
    container: ContainerStatusResponse;
    gitStatus: 'initialized';
    attempts: number;
}

export interface ContainerInitializationPollerOptions {
    userApi?: Pick<UserRestApi, 'getContainer'>;
    gitApi: Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
    statusSyncInterval?: number;
    maxAttempts?: number;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    credentialPrompt?: (context: GitCredentialPromptContext) => Promise<GitCredentialSubmitRequest | undefined>;
}

export interface ContainerInitializationRunner {
    initialize(input: ContainerInitializationInput): Promise<unknown>;
}

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (activeSignals.length === 0) {
        return undefined;
    }
    if (activeSignals.length === 1) {
        return activeSignals[0];
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    for (const signal of activeSignals) {
        if (signal.aborted) {
            abort();
            break;
        }
        signal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}

export class ContainerInitializationError extends Error {
    public constructor(
        public readonly code: string,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'ContainerInitializationError';
    }
}

const DEFAULT_STATUS_SYNC_INTERVAL_SECONDS = 5;
const DEFAULT_MAX_ATTEMPTS = 60;
const KNOWN_GIT_STATUSES = new Set<GitStatus>([
    'starting',
    'credential_required',
    'credential_rejected',
    'processing',
    'initialized',
    'failed_timeout',
    'failed_max_attempts',
    'failed_unexpected_state',
    'failed_git',
    'failed_service',
    'failed_container',
    'failed_initialize',
    'failed_user_cancelled',
]);

export class ContainerInitializationPoller {
    private readonly userApi: Pick<UserRestApi, 'getContainer'> | undefined;
    private readonly gitApi: Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
    private readonly intervalMilliseconds: number;
    private readonly maxAttempts: number;
    private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    private readonly credentialPrompt: (context: GitCredentialPromptContext) => Promise<GitCredentialSubmitRequest | undefined>;
    private readonly inFlight = new Map<string, Promise<ContainerInitializationResult>>();

    public constructor(options: ContainerInitializationPollerOptions) {
        this.userApi = options.userApi;
        this.gitApi = options.gitApi;
        this.intervalMilliseconds = normalizeInterval(options.statusSyncInterval);
        this.maxAttempts = normalizeMaxAttempts(options.maxAttempts);
        this.sleep = options.sleep ?? sleep;
        this.credentialPrompt = options.credentialPrompt ?? (async () => promptForGitCredentials({
            identityReader: new GitConfigReader(),
        }));
    }

    public initialize(input: ContainerInitializationInput): Promise<ContainerInitializationResult> {
        let normalizedInput: ContainerInitializationInput;
        try {
            normalizedInput = normalizeInput(input);
        } catch (error) {
            return Promise.reject(error);
        }
        const key = `${normalizedInput.operatorUserId}\u0000${normalizedInput.serviceId}\u0000${normalizedInput.containerId}`;
        const existing = this.inFlight.get(key);
        if (existing) {
            return existing;
        }

        const promise = this.poll(normalizedInput).finally(() => {
            if (this.inFlight.get(key) === promise) {
                this.inFlight.delete(key);
            }
        });
        this.inFlight.set(key, promise);
        return promise;
    }

    private async poll(input: ContainerInitializationInput): Promise<ContainerInitializationResult> {
        let lastContainer: ContainerStatusResponse | undefined;
        const statusReader = input.statusReader ?? this.userApi;
        if (!statusReader) {
            throw new ContainerInitializationError('status_reader_missing', '创建 Git 会话时缺少容器状态接口');
        }
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            this.throwIfCancelled(input);
            let container: ContainerStatusResponse;
            try {
                container = await statusReader.getContainer(input.containerId);
                lastContainer = container;
            } catch (error) {
                if (attempt >= this.maxAttempts) {
                    throw this.maxAttemptsError(input, error);
                }
                await this.waitForNextAttempt(input);
                continue;
            }
            this.throwIfCancelled(input);

            const normalStatus = normalizeText(container.status);
            const finalGitStatus = normalizeOptionalText(container.git_fin_status);
            if (normalStatus === 'failed') {
                throw this.failure('failed_container', `服务 "${input.containerId}" 初始化失败`);
            }
            if (finalGitStatus?.startsWith('failed_')) {
                throw this.failure(finalGitStatus, `服务 "${input.containerId}" Git 初始化失败`);
            }
            if (finalGitStatus && finalGitStatus !== 'pending' && finalGitStatus !== 'initialized') {
                throw this.failure('failed_unexpected_state', `服务 "${input.containerId}" 返回了无法识别的 Git 状态`);
            }
            if (normalStatus === 'running' && finalGitStatus === 'initialized') {
                return {
                    containerId: input.containerId,
                    serviceId: input.serviceId,
                    operatorUserId: input.operatorUserId,
                    container,
                    gitStatus: 'initialized',
                    attempts: attempt,
                };
            }

            if (normalStatus === 'pending' || !finalGitStatus || finalGitStatus === 'pending') {
                let gitStatus: string;
                try {
                    gitStatus = normalizeGitStatus((await this.gitApi.getGitState(input.serviceId, input.operatorUserId)).git_status);
                } catch (error) {
                    if (attempt >= this.maxAttempts) {
                        throw this.maxAttemptsError(input, error);
                    }
                    await this.waitForNextAttempt(input);
                    continue;
                }
                this.throwIfCancelled(input);

                if (!isKnownGitStatus(gitStatus)) {
                    throw this.failure('failed_unexpected_state', `服务 "${input.containerId}" 返回了无法识别的 Git 状态`);
                }
                if (gitStatus.startsWith('failed_')) {
                    throw this.failure(gitStatus, `服务 "${input.containerId}" Git 初始化失败`);
                }
                if (gitStatus === 'credential_required' || gitStatus === 'credential_rejected') {
                    const credential = await this.credentialPrompt({
                        containerId: input.containerId,
                        serviceId: input.serviceId,
                        operatorUserId: input.operatorUserId,
                        gitStatus,
                    });
                    this.throwIfCancelled(input);
                    if (credential === undefined) {
                        await this.reportUserCancelled(input);
                        throw this.failure('failed_user_cancelled', `服务 "${input.containerId}" Git 凭证输入已取消`);
                    }
                    if (!isValidCredential(credential)) {
                        throw this.failure('credential_invalid', `服务 "${input.containerId}" Git 凭证不完整`);
                    }
                    try {
                        await this.gitApi.submitGitCredential(input.serviceId, input.operatorUserId, credential);
                    } catch (error) {
                        if (attempt >= this.maxAttempts) {
                            throw this.maxAttemptsError(input, error);
                        }
                        await this.waitForNextAttempt(input);
                        continue;
                    }
                    this.throwIfCancelled(input);
                }
            }

            if (attempt < this.maxAttempts) {
                await this.waitForNextAttempt(input);
            }
        }

        throw this.maxAttemptsError(input, lastContainer);
    }

    private async reportUserCancelled(input: ContainerInitializationInput): Promise<void> {
        try {
            await this.gitApi.reportUserCancelled(input.serviceId, input.operatorUserId);
        } catch {
            // Cancellation remains the user-visible outcome even if the report request fails.
        }
    }

    private async waitForNextAttempt(input: ContainerInitializationInput): Promise<void> {
        this.throwIfCancelled(input);
        await this.sleep(this.intervalMilliseconds, input.signal);
        this.throwIfCancelled(input);
    }

    private throwIfCancelled(input: ContainerInitializationInput): void {
        if (input.signal?.aborted) {
            throw this.failure('creation_cancelled', '当前创建流程已取消');
        }
    }

    private maxAttemptsError(input: ContainerInitializationInput, cause: unknown): ContainerInitializationError {
        return this.failure(
            'failed_max_attempts',
            `服务 "${input.containerId}" Git 初始化未在规定时间内完成`,
            cause,
        );
    }

    private failure(code: string, message: string, cause?: unknown): ContainerInitializationError {
        return new ContainerInitializationError(code, message, cause);
    }
}

function normalizeInput(input: ContainerInitializationInput): ContainerInitializationInput {
    const containerId = typeof input.containerId === 'string' ? input.containerId.trim() : '';
    const serviceId = typeof input.serviceId === 'string' ? input.serviceId.trim() : '';
    const operatorUserId = typeof input.operatorUserId === 'string' ? input.operatorUserId.trim() : '';
    if (!containerId) {
        throw new ContainerInitializationError('container_id_missing', '创建响应中缺少有效的 container_id');
    }
    if (!serviceId) {
        throw new ContainerInitializationError('service_id_missing', '创建响应中缺少有效的 service_id');
    }
    if (!operatorUserId) {
        throw new ContainerInitializationError('user_id_missing', '创建 Git 会话时缺少用户 ID');
    }
    return { ...input, containerId, serviceId, operatorUserId };
}

function normalizeInterval(seconds: number | undefined): number {
    return Number.isFinite(seconds) && (seconds ?? 0) >= 0
        ? (seconds ?? 0) * 1_000
        : DEFAULT_STATUS_SYNC_INTERVAL_SECONDS * 1_000;
}

function normalizeMaxAttempts(value: number | undefined): number {
    return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : DEFAULT_MAX_ATTEMPTS;
}

function normalizeText(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
    const normalized = normalizeText(value);
    return normalized || undefined;
}

function normalizeGitStatus(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isKnownGitStatus(value: string): value is GitStatus {
    return KNOWN_GIT_STATUSES.has(value as GitStatus);
}

function isValidCredential(value: unknown): value is GitCredentialSubmitRequest {
    return typeof value === 'object' && value !== null
        && 'type' in value && value.type === 'password'
        && 'git_username' in value
        && typeof value.git_username === 'string'
        && !!value.git_username.trim()
        && 'git_email' in value
        && typeof value.git_email === 'string'
        && 'git_password' in value
        && typeof value.git_password === 'string'
        && value.git_password.length > 0
        && 'persist' in value
        && typeof value.persist === 'boolean';
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new ContainerInitializationError('creation_cancelled', '当前创建流程已取消'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new ContainerInitializationError('creation_cancelled', '当前创建流程已取消'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
