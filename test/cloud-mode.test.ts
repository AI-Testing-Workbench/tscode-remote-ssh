import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CLOUD_MODE_ENVIRONMENT_VARIABLE,
    CLOUD_MODE_MARKER_PATH,
    detectCloudMode,
    initializeCloudMode,
    isCloudMode,
    refreshCloudMode,
    resetCloudModeCache,
} from '../src/cloudMode';

describe('cloud mode', () => {
    beforeEach(() => {
        resetCloudModeCache();
    });

    it('enables cloud mode when the environment variable is set', () => {
        const fileExists = vi.fn(() => false);

        expect(detectCloudMode({
            environment: { [CLOUD_MODE_ENVIRONMENT_VARIABLE]: '1' },
            fileExists,
        })).toBe(true);
        expect(fileExists).not.toHaveBeenCalled();
    });

    it('enables cloud mode when the marker file exists', () => {
        const fileExists = vi.fn((path: string) => path === CLOUD_MODE_MARKER_PATH);

        expect(detectCloudMode({ environment: {}, fileExists })).toBe(true);
        expect(fileExists).toHaveBeenCalledWith(CLOUD_MODE_MARKER_PATH);
    });

    it('returns false when neither cloud mode condition is present', () => {
        expect(detectCloudMode({ environment: {}, fileExists: () => false })).toBe(false);
    });

    it('records marker check failures and treats them as non-cloud mode', () => {
        const error = new Error('permission denied');
        const onFileCheckError = vi.fn();

        expect(detectCloudMode({
            environment: {},
            fileExists: () => {
                throw error;
            },
            onFileCheckError,
        })).toBe(false);
        expect(onFileCheckError).toHaveBeenCalledWith(error);
    });

    it('caches the value after activation', () => {
        const fileExists = vi.fn(() => true);
        const options = { environment: {}, fileExists };

        expect(initializeCloudMode(options)).toBe(true);
        expect(isCloudMode({ environment: {}, fileExists: () => false })).toBe(true);
        expect(fileExists).toHaveBeenCalledOnce();
    });

    it('refreshes the cached value when the sidebar is opened again', () => {
        let markerExists = true;
        const options = {
            environment: {},
            fileExists: () => markerExists,
        };

        expect(initializeCloudMode(options)).toBe(true);
        markerExists = false;
        expect(refreshCloudMode(options)).toBe(false);
        expect(isCloudMode()).toBe(false);
    });
});
