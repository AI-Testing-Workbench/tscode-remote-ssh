import type {
    AdminContainerResponse,
    AdminStateResponse,
    ContainerLimitResponse,
    ImageListItem,
} from '../api/models';

export type AdminTab = 'images' | 'containers' | 'whitelist' | 'adminUsers';

export type AdminPageStatus = 'loading' | 'ready' | 'error' | 'forbidden';

export interface AdminPanelState {
    status: AdminPageStatus;
    activeTab: AdminTab;
    search: string;
    selectedImageFilename?: string;
    error?: string;
    images: ImageListItem[];
    defaultImage: string | null;
    containers: AdminContainerResponse[];
    orphanContainerIds: string[];
    stats?: AdminStateResponse;
    limit?: ContainerLimitResponse;
    whitelistUsers: string[];
    adminUsers: string[];
}
