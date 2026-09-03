export interface UserCreateContainerRequest {
    user_id: string;
    gitee_user?: string | null;
    gitee_repository?: string | null;
    gitee_branch?: string | null;
    gitee_url?: string | null;
    authorize_general_account?: boolean | null;
}

export type CreateContainerRequest = UserCreateContainerRequest;

export interface UserContainerQuery {
    user_id: string;
    gitee_user?: string | null;
    gitee_repository?: string | null;
    gitee_branch?: string | null;
}

export interface ContainerIdsResponse {
    container_ids: string[];
}

export interface ContainerStatusResponse {
    container_id: string;
    status: string;
    endpoint?: string | null;
    started_at?: string | null;
    expires_at?: string | null;
    gitee_user: string;
    gitee_repository: string;
}

export interface CreateContainerResponse {
    container_id: string;
    status: string;
    endpoint?: string | null;
    started_at?: string | null;
    expires_at?: string | null;
}

export interface AdminCheckRequest {
    user_id: string;
}

export interface AdminCheckResponse {
    admin: boolean;
}

export interface AdminCreateContainerRequest {
    user_id: string;
    gitee_user?: string | null;
    gitee_repository?: string | null;
    gitee_branch?: string | null;
    gitee_url?: string | null;
    authorize_general_account?: boolean | null;
    image?: string | null;
    expiration_hours?: number | null;
    cpu?: number | null;
    memory?: number | null;
}

export interface AdminContainerResponse {
    container_id: string;
    status: string;
    endpoint?: string | null;
    started_at?: string | null;
    expires_at?: string | null;
    image: string;
    user_id: string;
    gitee_user: string;
    gitee_repository: string;
    gitee_branch?: string | null;
    created_at: string;
    expiration_hours: number;
    authorize_general_account: boolean;
    deleted_at?: string | null;
    business_deleted: boolean;
}

export interface AdminContainerListResponse {
    containers: AdminContainerResponse[];
}

export interface ExpirationRequest {
    expiration_hours: number;
}

export interface ExpirationResponse {
    container_id: string;
    expires_at: string | null;
}

export interface ContainerLimitRequest {
    container_limit: number;
}

export interface ContainerLimitResponse {
    container_count: number;
    container_limit: number;
}

export interface ImageReferenceRequest {
    full_name: string;
}

export interface ImageDeleteRequest {
    full_name: string;
    also_registry?: boolean;
}

export interface ImageListItem {
    id: string;
    full_name: string;
    registry: string;
    namespace: string;
    name: string;
    version: string;
    created_at?: string | null;
    size: number;
    status: string;
}

export interface ImageListResponse {
    images: ImageListItem[];
}

export interface DefaultImageResponse {
    full_name?: string | null;
}

export interface UserIdRequest {
    user_id: string;
}

export interface UserIdsResponse {
    user_ids: string[];
}

export interface UserMutationResponse {
    user_id: string;
}

export interface ErrorResponse {
    code: string;
    message: string;
}

export interface UploadImageInput {
    file: Uint8Array;
    filename: string;
    registry?: string | null;
    namespace?: string | null;
    auto_push?: boolean;
}
