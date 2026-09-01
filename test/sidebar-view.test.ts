import { describe, expect, it, vi } from 'vitest';
import { SidebarSyncState } from '../src/sidebarView';

describe('SidebarSyncState', () => {
    it('publishes the latest sync result and stops after disposal', () => {
        const state = new SidebarSyncState();
        const listener = vi.fn();
        const subscription = state.subscribe(listener);
        const result = { containers: [], changed: true };

        state.update(result);
        expect(listener).toHaveBeenCalledWith(result);
        expect(state.getState()).toEqual(result);

        subscription.dispose();
        state.update({ containers: [], changed: false });
        expect(listener).toHaveBeenCalledOnce();

        state.dispose();
        state.update(result);
        expect(state.getState()).toEqual({ containers: [], changed: false });
    });
});
