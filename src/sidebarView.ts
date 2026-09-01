import { ContainerSyncResult } from './containerSync';

export type SidebarSyncListener = (result: ContainerSyncResult) => void;

export class SidebarSyncState {
    private currentResult: ContainerSyncResult = {
        containers: [],
        changed: false,
    };
    private readonly listeners = new Set<SidebarSyncListener>();
    private disposed = false;

    public getState(): ContainerSyncResult {
        return {
            ...this.currentResult,
            containers: this.currentResult.containers.slice(),
        };
    }

    public update(result: ContainerSyncResult): void {
        if (this.disposed) {
            return;
        }

        this.currentResult = result;
        for (const listener of this.listeners) {
            listener(result);
        }
    }

    public subscribe(listener: SidebarSyncListener): { dispose: () => void } {
        if (this.disposed) {
            return { dispose: () => undefined };
        }

        this.listeners.add(listener);
        return {
            dispose: () => this.listeners.delete(listener),
        };
    }

    public dispose(): void {
        this.disposed = true;
        this.listeners.clear();
    }
}
