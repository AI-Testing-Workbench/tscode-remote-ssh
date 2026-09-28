import type { ContainerStatusResponse, GitCredentialSubmitRequest, GitFailureStatus, GitStatus } from './api/models';
import { formatRestClientError, RestClientError, type GitRestApi, type UserRestApi } from './api/restClient';
import { GitConfigReader } from './gitConfig';
import { promptForGitCredentials } from './gitCredentialPrompt';

export interface ContainerInitializationInput {
    containerId: string;
    serviceId: string;
    operatorUserId: string;
    statusReader?: Pick<UserRestApi, 'getContainer'>;
    signal?: AbortSignal;
    /** 创建响应可能不包含服务地址；码云状态进入 waiting 后读取实时状态。 */
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
    gitApi: Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>
        & Partial<Pick<GitRestApi, 'reportGitFailure'>>;
    runGitClone?: (container: ContainerStatusResponse, signal?: AbortSignal) => Promise<void>;
    statusSyncInterval?: number;
    maxAttempts?: number;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    credentialPrompt?: (context: GitCredentialPromptContext) => Promise<GitCredentialSubmitRequest | undefined>;
}

export interface ContainerInitializationRunner {
    initialize(input: ContainerInitializationInput): Promise<unknown>;
}

export function getInitializationResultContainer(value: unknown): ContainerStatusResponse | undefined {
    if (!isRecord(value) || !isRecord(value.container)) {
        return undefined;
    }
    const container = value.container;
    if (typeof container.container_id !== 'string' || typeof container.status !== 'string') {
        return undefined;
    }
    return container as unknown as ContainerStatusResponse;
}

export function formatContainerInitializationError(error: unknown): string {
    if (!(error instanceof ContainerInitializationError)) {
        return formatRestClientError(error);
    }

    const apiCode = error.cause instanceof RestClientError ? error.cause.code : undefined;
    const codeDetails = apiCode && apiCode !== error.code
        ? `错误码: ${error.code}，API错误码: ${apiCode}`
        : `错误码: ${error.code}`;
    return `${error.message}\n${codeDetails}`;
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
    'waiting',
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
    private readonly gitApi: ContainerInitializationPollerOptions['gitApi'];
    private readonly runGitClone: ContainerInitializationPollerOptions['runGitClone'];
    private readonly intervalMilliseconds: number;
    private readonly maxAttempts: number;
    private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    private readonly credentialPrompt: (context: GitCredentialPromptContext) => Promise<GitCredentialSubmitRequest | undefined>;
    private readonly inFlight = new Map<string, Promise<ContainerInitializationResult>>();

    public constructor(options: ContainerInitializationPollerOptions) {
        this.userApi = options.userApi;
        this.gitApi = options.gitApi;
        this.runGitClone = options.runGitClone;
        this.intervalMilliseconds = normalizeInterval(options.statusSyncInterval);
        this.maxAttempts = normalizeMaxAttempts(options.maxAttempts);
        this.sleep = options.sleep ?? sleep;
        this.credentialPrompt = options.credentialPrompt ?? (context => promptForGitCredentials({
            identityReader: new GitConfigReader(),
            gitStatus: context.gitStatus,
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
        let gitClonePromise: Promise<{ error?: unknown }> | undefined;
        let gitCloneFailed = false;
        let gitCloneError: unknown;
        let serverFinalFailureObserved = false;
        let serverInitializationSucceeded = false;
        let pluginFailureReportAttempted = false;
        let reportFailureStatus: GitFailureStatus | undefined;
        const gitCloneController = new AbortController();
        const gitCloneSignal = gitCloneController.signal;
        const statusReader = input.statusReader ?? this.userApi;
        const abortGitClone = () => gitCloneController.abort();
        if (input.signal?.aborted) {
            abortGitClone();
        } else {
            input.signal?.addEventListener('abort', abortGitClone, { once: true });
        }
        try {
            if (!statusReader) {
                throw new ContainerInitializationError('status_reader_missing', '创建码云初始化会话时缺少容器状态接口');
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
                    serverFinalFailureObserved = finalGitStatus?.startsWith('failed_') ?? false;
                    throw this.failure(
                        finalGitStatus?.startsWith('failed_') ? finalGitStatus : 'failed_container',
                        `服务 "${input.containerId}" 初始化失败\n请联系支持团队解决`,
                    );
                }
                if (finalGitStatus?.startsWith('failed_')) {
                    serverFinalFailureObserved = true;
                    throw this.failure(finalGitStatus, `服务 "${input.containerId}" 码云初始化失败\n请联系支持团队解决`);
                }
                if (finalGitStatus && finalGitStatus !== 'pending' && finalGitStatus !== 'initialized') {
                    throw this.failure('failed_unexpected_state', `服务 "${input.containerId}" 返回了无法识别的码云状态\n请联系支持团队解决`);
                }
                if (normalStatus === 'running' && finalGitStatus === 'initialized') {
                    serverInitializationSucceeded = true;
                    const cloneResult = await this.waitForGitClone(gitClonePromise, input);
                    if (gitCloneFailed || cloneResult.error !== undefined) {
                        throw this.failure('git_clone_execution_failed', `服务 "${input.containerId}" 的码云初始化脚本执行失败`, cloneResult.error);
                    }
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
                        throw this.failure('failed_unexpected_state', `服务 "${input.containerId}" 返回了无法识别的码云状态\n请联系支持团队解决`);
                    }
                    if (gitStatus.startsWith('failed_')) {
                        serverFinalFailureObserved = true;
                        throw this.failure(gitStatus, `服务 "${input.containerId}" 码云初始化失败\n请联系支持团队解决`);
                    }
                    if (gitCloneFailed) {
                        throw this.failure('git_clone_execution_failed', `服务 "${input.containerId}" 的码云初始化脚本执行失败`, gitCloneError);
                    }
                    if (gitStatus === 'waiting' && !gitClonePromise) {
                        if (!this.runGitClone) {
                            throw this.failure('git_clone_runner_missing', `服务 "${input.containerId}" 缺少码云初始化脚本执行器`);
                        }
                        if (!normalizeOptionalText(container.endpoint)) {
                            throw this.failure('container_endpoint_missing', `服务 "${input.containerId}" 已就绪但未返回连接地址`);
                        }
                        gitClonePromise = Promise.resolve()
                            .then(() => this.runGitClone!(container, gitCloneSignal))
                            .then(() => ({}), error => {
                                gitCloneFailed = true;
                                gitCloneError = error;
                                return { error };
                            });
                    }

                    if (!gitClonePromise && !gitStatus.startsWith('failed_') && gitStatus !== 'waiting') {
                        throw this.failure('failed_unexpected_state', `服务 "${input.containerId}" 在码云初始化脚本启动前返回了异常状态`);
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
                            reportFailureStatus = 'failed_user_cancelled';
                            await this.reportUserCancelled(input);
                            pluginFailureReportAttempted = true;
                            throw this.failure('failed_user_cancelled', `服务 "${input.containerId}" 码云凭证输入已取消`);
                        }
                        if (!isValidCredential(credential)) {
                            throw this.failure('credential_invalid', `服务 "${input.containerId}" 码云凭证不完整`);
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
        } catch (error) {
            gitCloneController.abort();
            if (!serverFinalFailureObserved && !serverInitializationSucceeded && !pluginFailureReportAttempted) {
                reportFailureStatus ??= getInitializationFailureReportStatus(error);
                if (reportFailureStatus) {
                    try {
                        await this.gitApi.reportGitFailure?.(input.serviceId, input.operatorUserId, reportFailureStatus);
                    } catch {
                        // Keep the original initialization error if the final status cannot be reported.
                    }
                }
            }
            throw error;
        } finally {
            input.signal?.removeEventListener('abort', abortGitClone);
        }
    }

    private async waitForGitClone(
        promise: Promise<{ error?: unknown }> | undefined,
        input: ContainerInitializationInput,
    ): Promise<{ error?: unknown }> {
        this.throwIfCancelled(input);
        if (!promise) {
            throw this.failure('git_clone_not_started', `服务 "${input.containerId}" 尚未启动码云初始化脚本`);
        }
        const result = await promise;
        this.throwIfCancelled(input);
        return result;
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
            `服务 "${input.containerId}" 码云初始化未在规定时间内完成\n请联系支持团队解决`,
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
        throw new ContainerInitializationError('container_id_missing', '创建响应中缺少有效的容器编号');
    }
    if (!serviceId) {
        throw new ContainerInitializationError('service_id_missing', '创建响应中缺少有效的服务编号');
    }
    if (!operatorUserId) {
        throw new ContainerInitializationError('user_id_missing', '创建码云初始化会话时缺少用户编号');
    }
    return { ...input, containerId, serviceId, operatorUserId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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

function getInitializationFailureReportStatus(error: unknown): GitFailureStatus | undefined {
    if (error instanceof RestClientError) {
        return 'failed_service';
    }
    if (!(error instanceof ContainerInitializationError)) {
        return 'failed_initialize';
    }

    switch (error.code) {
        case 'creation_cancelled':
            return undefined;
        case 'failed_timeout':
        case 'failed_max_attempts':
        case 'failed_unexpected_state':
        case 'failed_git':
        case 'failed_service':
        case 'failed_container':
        case 'failed_initialize':
        case 'failed_user_cancelled':
            return error.code;
        case 'status_reader_missing':
            return 'failed_service';
        case 'container_endpoint_missing':
            return 'failed_container';
        default:
            return 'failed_initialize';
    }
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
