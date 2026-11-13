import type { ContainerTypeValue } from '../api/models';

export interface AdminContainerType {
    type: ContainerTypeValue;
    label: string;
}

export const ADMIN_CONTAINER_TYPES: AdminContainerType[] = [
    { type: 'testagent_cloud', label: '默认镜像' },
    { type: 'testagent_cloud_chrome', label: '浏览器执行镜像' },
    { type: 'evaluation_cloud', label: '测评镜像' },
    { type: 'autotest_cloud', label: '自动化跑批镜像' },
];

export const ADMIN_DEFAULT_IMAGE_GROUPS: AdminContainerType[] = [
    { type: 'testagent_cloud', label: '默认镜像' },
    { type: 'evaluation_cloud', label: '测评镜像' },
    { type: 'autotest_cloud', label: '自动化跑批镜像' },
];

const DEFAULT_IMAGE_TYPE_BY_CONTAINER: Record<ContainerTypeValue, ContainerTypeValue> = {
    testagent_cloud: 'testagent_cloud',
    testagent_cloud_chrome: 'testagent_cloud',
    evaluation_cloud: 'evaluation_cloud',
    autotest_cloud: 'autotest_cloud',
};

export function isContainerTypeValue(value: unknown): value is ContainerTypeValue {
    return typeof value === 'string' && ADMIN_CONTAINER_TYPES.some(entry => entry.type === value);
}

export function containerTypeOf(value: unknown): ContainerTypeValue | undefined {
    return isContainerTypeValue(value) ? value : undefined;
}

export function containerTypeLabel(type: string | null | undefined): string {
    const knownLabel = ADMIN_CONTAINER_TYPES.find(entry => entry.type === type)?.label;
    return knownLabel ?? (type || '未知类型');
}

export function defaultImageTypeForContainer(type: ContainerTypeValue): ContainerTypeValue {
    return DEFAULT_IMAGE_TYPE_BY_CONTAINER[type];
}

export function defaultImageGroupLabel(type: ContainerTypeValue): string {
    return ADMIN_DEFAULT_IMAGE_GROUPS.find(entry => entry.type === type)?.label ?? containerTypeLabel(type);
}
