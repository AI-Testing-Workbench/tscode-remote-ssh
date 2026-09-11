import { describe, expect, it } from 'vitest';
import {
    ContainerOperationRegistry,
} from '../src/containerOperations';

describe('ContainerOperationRegistry', () => {
    it('serializes operations for one service and publishes phase changes', () => {
        const registry = new ContainerOperationRegistry();
        const events: string[] = [];
        registry.subscribe(event => events.push(`${event.type}:${event.operation.phase}`));

        const operation = registry.begin('container-1', 'stop', 'admin');

        expect(operation).toEqual({
            containerId: 'container-1',
            action: 'stop',
            phase: 'processing',
            source: 'admin',
            operationId: 1,
        });
        expect(registry.begin('container-1', 'delete', 'admin')).toBeUndefined();
        expect(registry.setPhase('container-1', 'reconciling')).toMatchObject({ phase: 'reconciling' });
        expect(registry.complete('container-1')).toMatchObject({ containerId: 'container-1', action: 'stop' });
        expect(registry.get('container-1')).toBeUndefined();
        expect(events).toEqual(['started:processing', 'reconciling:reconciling', 'completed:reconciling']);
    });

    it('returns defensive operation snapshots and isolates listener failures', () => {
        const registry = new ContainerOperationRegistry();
        registry.subscribe(() => {
            throw new Error('listener failure');
        });
        const operation = registry.begin(' container-2 ', 'delete', 'sidebar');

        expect(operation).toMatchObject({ containerId: 'container-2', source: 'sidebar' });
        if (operation) {
            operation.phase = 'reconciling';
        }
        expect(registry.get('container-2')).toMatchObject({ phase: 'processing' });
    });

    it('does not let a stale operation snapshot change a newer operation', () => {
        const registry = new ContainerOperationRegistry();
        const first = registry.begin('container-3', 'restart', 'admin');
        expect(first).toBeDefined();

        registry.complete('container-3', 'failed', first?.operationId);
        const second = registry.begin('container-3', 'restart', 'sidebar');
        expect(second).toBeDefined();

        expect(registry.setPhase('container-3', 'reconciling', first?.operationId)).toBeUndefined();
        expect(registry.complete('container-3', 'failed', first?.operationId)).toBeUndefined();
        expect(registry.get('container-3')).toMatchObject({
            source: 'sidebar',
            phase: 'processing',
            operationId: second?.operationId,
        });
    });
});
