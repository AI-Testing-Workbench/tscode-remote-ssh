import type { ContainerTypeValue } from '../api/models';

export interface AdminContainerType {
    type: ContainerTypeValue;
    label: string;
}

export const ADMIN_CONTAINER_TYPES: AdminContainerType[] = [
    { type: 'testagent_cloud', label: 'TestAgentCloud' },
    { type: 'autotest_cloud', label: '自动化跑批' },
];

export function isContainerTypeValue(value: unknown): value is ContainerTypeValue {
    return value === 'testagent_cloud' || value === 'autotest_cloud';
}

export function containerTypeOf(value: unknown): ContainerTypeValue | undefined {
    return isContainerTypeValue(value) ? value : undefined;
}

export function containerTypeLabel(type: string | null | undefined): string {
    if (type === 'testagent_cloud') {
        return 'TestAgentCloud';
    }
    if (type === 'autotest_cloud') {
        return '自动化跑批';
    }
    return type || '未知类型';
}
