export const CONTAINER_OPERATION_ACTIONS = [
    'start',
    'stop',
    'restart',
    'delete',
    'permanent-delete',
    'restore',
] as const;

export type ContainerOperationAction = typeof CONTAINER_OPERATION_ACTIONS[number];
export type ContainerOperationPhase = 'processing' | 'reconciling';
export type ContainerOperationSource = 'admin' | 'sidebar';
export type ContainerOperationOutcome = 'succeeded' | 'failed';

export interface ContainerOperationState {
    containerId: string;
    action: ContainerOperationAction;
    phase: ContainerOperationPhase;
    source: ContainerOperationSource;
}

export interface ContainerOperationEvent {
    type: 'started' | 'reconciling' | 'completed';
    operation: ContainerOperationState;
    outcome?: ContainerOperationOutcome;
}

export type ContainerOperationListener = (event: ContainerOperationEvent) => void;

export class ContainerOperationRegistry {
    private readonly operations = new Map<string, ContainerOperationState>();
    private readonly listeners = new Set<ContainerOperationListener>();

    public begin(
        containerId: string,
        action: ContainerOperationAction,
        source: ContainerOperationSource,
    ): ContainerOperationState | undefined {
        const normalizedId = containerId.trim();
        if (!normalizedId || this.operations.has(normalizedId)) {
            return undefined;
        }

        const operation: ContainerOperationState = {
            containerId: normalizedId,
            action,
            phase: 'processing',
            source,
        };
        this.operations.set(normalizedId, operation);
        this.notify({ type: 'started', operation });
        return cloneOperation(operation);
    }

    public setPhase(containerId: string, phase: ContainerOperationPhase): ContainerOperationState | undefined {
        const current = this.operations.get(containerId);
        if (!current) {
            return undefined;
        }
        if (current.phase === phase) {
            return cloneOperation(current);
        }

        const operation = { ...current, phase };
        this.operations.set(containerId, operation);
        this.notify({ type: 'reconciling', operation });
        return cloneOperation(operation);
    }

    public complete(containerId: string, outcome: ContainerOperationOutcome = 'succeeded'): ContainerOperationState | undefined {
        const current = this.operations.get(containerId);
        if (!current) {
            return undefined;
        }

        this.operations.delete(containerId);
        const operation = cloneOperation(current);
        this.notify({ type: 'completed', operation, outcome });
        return operation;
    }

    public get(containerId: string): ContainerOperationState | undefined {
        const operation = this.operations.get(containerId);
        return operation ? cloneOperation(operation) : undefined;
    }

    public list(): ContainerOperationState[] {
        return Array.from(this.operations.values(), cloneOperation);
    }

    public has(containerId: string): boolean {
        return this.operations.has(containerId);
    }

    public subscribe(listener: ContainerOperationListener): { dispose: () => void } {
        this.listeners.add(listener);
        return {
            dispose: () => this.listeners.delete(listener),
        };
    }

    public dispose(): void {
        this.operations.clear();
        this.listeners.clear();
    }

    private notify(event: ContainerOperationEvent): void {
        for (const listener of this.listeners) {
            try {
                listener({
                    ...event,
                    operation: cloneOperation(event.operation),
                });
            } catch {
                // A view listener must not interrupt the operation lifecycle.
            }
        }
    }
}

export function isContainerOperationAction(value: string): value is ContainerOperationAction {
    return (CONTAINER_OPERATION_ACTIONS as readonly string[]).includes(value);
}

export function getContainerOperationStatus(action: ContainerOperationAction): string {
    switch (action) {
        case 'start':
            return 'starting';
        case 'stop':
            return 'stopping';
        case 'restart':
            return 'restarting';
        case 'delete':
        case 'permanent-delete':
            return 'deleting';
        case 'restore':
            return 'restoring';
    }
}

export function getContainerOperationName(action: ContainerOperationAction): string {
    switch (action) {
        case 'start':
            return '启动';
        case 'stop':
            return '停止';
        case 'restart':
            return '重启';
        case 'delete':
            return '业务删除';
        case 'permanent-delete':
            return '永久删除';
        case 'restore':
            return '恢复';
    }
}

function cloneOperation(operation: ContainerOperationState): ContainerOperationState {
    return { ...operation };
}
