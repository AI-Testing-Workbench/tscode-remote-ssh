import type {
    AdminContainerResponse,
    AdminStateResponse,
    ContainerLimitResponse,
    ContainerTypeValue,
    ImageListItem,
} from '../api/models';

export type AdminTab = 'images' | 'containers' | 'volume' | 'whitelist' | 'adminUsers';

export type AdminPageStatus = 'loading' | 'ready' | 'error' | 'forbidden';

export type VolumePageStatus = 'idle' | 'loading' | 'disabled' | 'external' | 'ready' | 'error';

export interface AdminVolumeState {
    status: VolumePageStatus;
    frameUrl?: string;
    frameMode?: 'direct' | 'bridge';
    externalUrl?: string;
    error?: string;
}

export interface AdminDefaultImage {
    type: ContainerTypeValue;
    fullName: string | null;
}

export interface AdminPanelState {
    status: AdminPageStatus;
    activeTab: AdminTab;
    search: string;
    selectedImageFilename?: string;
    error?: string;
    images: ImageListItem[];
    defaultImages: AdminDefaultImage[];
    containers: AdminContainerResponse[];
    orphanContainerIds: string[];
    stats?: AdminStateResponse;
    limit?: ContainerLimitResponse;
    whitelistUsers: string[];
    adminUsers: string[];
    volume?: AdminVolumeState;
}
