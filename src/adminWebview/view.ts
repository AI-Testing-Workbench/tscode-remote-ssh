import type {
    AdminContainerResponse,
    AdminStateResponse,
    ContainerLimitResponse,
    ImageListItem,
} from '../api/models';
import { ADMIN_WEBVIEW_SCRIPT } from './script';
import type { AdminPanelState, AdminTab } from './types';

interface SelectOption {
    value: string;
    label: string;
    selected?: boolean;
    disabled?: boolean;
}

export function renderAdminPage(state: AdminPanelState, nonce: string, cspSource: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">${ADMIN_CSS}</style>
</head>
<body>
    ${renderAdminContent(state)}
    <script nonce="${nonce}">${ADMIN_WEBVIEW_SCRIPT}</script>
</body>
</html>`;
}

export function renderAdminContent(state: AdminPanelState): string {
    return state.status === 'ready' ? renderReadyPage(state) : renderStatusPage(state);
}

function renderStatusPage(state: AdminPanelState): string {
    if (state.status === 'loading') {
        return '<main class="status-page"><div class="status-card"><span class="spinner" aria-hidden="true"></span><h1>正在加载管理员页面</h1><p>正在校验权限和读取数据...</p></div></main>';
    }

    const title = state.status === 'forbidden' ? '无权访问管理员页面' : '管理员页面加载失败';
    const message = state.error ?? '后端 TestAgent Cloud 管理服务暂时不可用';
    return `<main class="status-page"><div class="status-card error-card">
        <span class="status-icon" aria-hidden="true">!</span>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        ${state.status === 'forbidden' ? '' : '<button class="primary-button" type="button" data-action="retry">重新加载</button>'}
    </div></main>`;
}

function renderReadyPage(state: AdminPanelState): string {
    return `<main class="admin-shell" data-patch-key="admin-root">
        <header class="page-header" data-patch-key="page-header">
            <h1>管理员页面</h1>
            <button class="tonal-button" type="button" data-action="refresh">刷新</button>
        </header>
        ${renderStats(state.stats, state.limit, state.orphanContainerIds)}
        ${renderDefaultBanner(state.defaultImage, state.images)}
        ${renderLimitForm(state.limit)}
        <nav class="tab-bar" data-patch-key="tab-bar">
            ${renderTabButton('images', '镜像管理', state.activeTab)}
            ${renderTabButton('containers', '容器管理', state.activeTab)}
            ${renderTabButton('whitelist', '白名单用户管理', state.activeTab)}
            ${renderTabButton('adminUsers', '管理员用户管理', state.activeTab)}
        </nav>
        ${renderTabContent(state)}
        ${renderLogModal()}
    </main>`;
}

function renderTabButton(tab: AdminTab, label: string, activeTab: AdminTab): string {
    const active = tab === activeTab;
    return `<button class="tab-button${active ? ' active' : ''}" type="button" data-action="tab" data-tab="${tab}" aria-selected="${active}">${label}</button>`;
}

function renderTabContent(state: AdminPanelState): string {
    switch (state.activeTab) {
        case 'images':
            return renderImagesTab(state.images, state.defaultImage, state.selectedImageFilename, state.search, state.containers);
        case 'containers':
            return renderContainersTab(state.containers, state.images, state.defaultImage, state.search);
        case 'whitelist':
            return renderUsersTab('whitelist', '白名单用户', state.whitelistUsers, state.search);
        case 'adminUsers':
            return renderUsersTab('admin', '管理员用户', state.adminUsers, state.search);
    }
}

function renderDefaultBanner(defaultImage: string | null, images: ImageListItem[]): string {
    const imageExists = Boolean(defaultImage && images.some(image => image.full_name === defaultImage));
    const missingDefault = Boolean(defaultImage && !imageExists);
    const stateClass = !defaultImage ? ' danger' : missingDefault ? ' warning' : '';
    const stateTag = defaultImage && !imageExists
        ? '<span class="tag warning-tag">默认镜像不存在</span>'
        : !defaultImage
            ? '<span class="tag danger-tag">默认镜像未配置</span>'
            : '';
    return `<div class="stat-card default-banner overview-card${stateClass}" data-patch-key="default-image">
        <div class="default-image-copy">
            <div class="default-image-line"><span class="default-label">默认镜像</span><strong class="default-image-name">${defaultImage ? escapeHtml(defaultImage) : '请及时设置默认镜像'}</strong></div>
        </div>
        ${stateTag}
    </div>`;
}

function renderImagesTab(
    images: ImageListItem[],
    defaultImage: string | null,
    selectedImageFilename?: string,
    search = '',
    containers: AdminContainerResponse[] = [],
): string {
    const imageUsage = new Map<string, number>();
    containers.forEach(container => imageUsage.set(container.image, (imageUsage.get(container.image) ?? 0) + 1));
    const rows = images.map(image => renderImageRow(image, defaultImage, imageUsage.get(image.full_name) ?? 0)).join('');
    const empty = images.length ? '' : '<p class="empty-message" data-empty-data>暂无镜像数据</p>';
    const emptySearch = images.length ? '<p class="empty-message" data-empty-search hidden>没有匹配的镜像</p>' : '';
    return `<section class="tab-panel" data-tab-panel data-patch-key="tab-images" aria-labelledby="images-tab">
        <div class="section-heading"><h2 id="images-tab">镜像管理 <span class="count-badge tag">${images.length} 个</span></h2></div>
        <details class="image-upload-card collapsible-card" data-form="uploadImage" open>
            <summary class="collapsible-summary"><strong>上传镜像</strong><span>导入镜像文件并可选推送至注册表 (镜像仓库)</span><span class="collapse-chevron" aria-hidden="true"></span></summary>
            <div class="upload-body">
                <div class="upload-file-row">
                    <button class="tonal-button" type="button" data-action="selectImageFile">选择镜像文件</button>
                    <span class="selected-file" data-selected-file>${escapeHtml(selectedImageFilename ?? '未选择镜像文件')}</span>
                </div>
                <div class="upload-target-row">
                    <label>注册表 (镜像仓库)<input data-field="registry" data-persist-key="upload.registry" type="text" placeholder="127.0.0.1:5000"></label>
                    <label>命名空间<input data-field="namespace" data-persist-key="upload.namespace" type="text" placeholder="testagent"></label>
                </div>
                <div class="upload-actions-row">
                    <button class="primary-button" type="button" data-action="uploadImage">上传镜像</button>
                    <label class="check-button"><input data-field="autoPush" data-persist-key="upload.autoPush" type="checkbox" checked>同时推送至注册表 (镜像仓库)</label>
                </div>
            </div>
        </details>
        ${renderSearchBox('搜索镜像...', search)}
        ${renderListControls('images')}
        <div class="resource-list image-list" data-resource-list><div class="resource-items" data-resource-items>${rows}</div>${empty}${emptySearch}</div>
    </section>`;
}

function renderImageRow(image: ImageListItem, defaultImage: string | null, containerCount: number): string {
    const imageStatus = image.status.toLowerCase();
    const isDefault = image.full_name === defaultImage || imageStatus === 'default';
    const pushed = imageStatus === 'pushed' || isDefault;
    const status = isDefault ? 'default' : imageStatus;
    const usageTag = containerCount > 0 ? `<span class="image-usage tag">被 ${containerCount} 个容器使用中</span>` : '';
    const searchText = [image.full_name, image.registry, image.namespace, image.name, image.version, status, imageStatusLabel(status)].join(' ');
    return `<article class="resource-row image-row searchable" data-patch-key="image:${escapeAttribute(image.full_name)}" data-search-text="${escapeAttribute(searchText)}" data-filter-status="${escapeAttribute(status)}" data-sort-name="${escapeAttribute(image.full_name)}" data-sort-status="${escapeAttribute(status)}" data-sort-size="${image.size}" data-sort-created="${escapeAttribute(image.created_at)}">
        <div class="resource-main"><div class="image-title"><strong>${escapeHtml(image.full_name)}</strong><span class="status-chip tag ${statusClass(status)}">${escapeHtml(imageStatusLabel(status))}</span><span class="image-size tag">${formatBytes(image.size)}</span>${usageTag}</div></div>
        <div class="row-actions">
            <button class="small-button" type="button" data-action="pushImage" data-full-name="${escapeAttribute(image.full_name)}" ${pushed ? 'disabled' : ''}>推送</button>
            ${isDefault
                ? '<button class="small-button tonal-button" type="button" data-action="unsetDefaultImage">取消默认</button>'
                : `<button class="small-button" type="button" data-action="setDefaultImage" data-full-name="${escapeAttribute(image.full_name)}" ${pushed ? '' : 'disabled'}>设为默认</button>`}
            <button class="small-button danger-button" type="button" data-action="deleteImage" data-full-name="${escapeAttribute(image.full_name)}" ${isDefault ? 'disabled' : ''}>删除</button>
            <label class="row-check check-button${isDefault ? ' disabled' : ''}"><input data-field="alsoRegistry" data-persist-key="image.${escapeAttribute(image.full_name)}.alsoRegistry" type="checkbox" checked${isDefault ? ' disabled' : ''}>同步推送至注册表 (镜像仓库)</label>
        </div>
    </article>`;
}

function renderContainersTab(
    containers: AdminContainerResponse[],
    images: ImageListItem[],
    defaultImage: string | null,
    search = '',
): string {
    const rows = containers.map(renderContainerRow).join('');
    const empty = containers.length ? '' : '<p class="empty-message" data-empty-data>暂无容器数据</p>';
    const emptySearch = containers.length ? '<p class="empty-message" data-empty-search hidden>没有匹配的容器</p>' : '';
    return `<section class="tab-panel" data-tab-panel data-patch-key="tab-containers" aria-labelledby="containers-tab">
        <div class="section-heading"><h2 id="containers-tab">容器管理 <span class="count-badge tag">${containers.length} 个</span></h2></div>
        <details class="form-card collapsible-card" data-form="createContainer" open>
            <summary class="collapsible-summary"><strong>创建容器</strong><span>管理员可为任意用户创建容器服务</span><span class="collapse-chevron" aria-hidden="true"></span></summary>
            <div class="create-form-body">
                <div class="form-row single-field">
                    <label>用户 ID<input data-field="user_id" data-persist-key="create.user_id" type="text" required placeholder="10001"></label>
                </div>
                <div class="gitee-option-row">
                    <label class="mode-radio"><input data-field="giteeMode" data-persist-key="create.giteeMode" name="gitee-mode" value="none" type="radio" checked>无码云仓库绑定</label>
                    <div class="gitee-fields mode-description" data-gitee-mode-panel="none"><span>创建容器时不绑定码云仓库</span></div>
                </div>
                <div class="gitee-option-row">
                    <label class="mode-radio"><input data-field="giteeMode" data-persist-key="create.giteeMode" name="gitee-mode" value="full" type="radio">码云拉取地址</label>
                    <div class="gitee-fields" data-gitee-mode-panel="full">
                        <label>码云拉取地址<input data-field="gitee_full_url" data-persist-key="create.gitee_full_url" type="text" placeholder="完整的 https://XXX 或者 git@XXX" disabled></label>
                    </div>
                </div>
                <div class="gitee-option-row">
                    <label class="mode-radio"><input data-field="giteeMode" data-persist-key="create.giteeMode" name="gitee-mode" value="parts" type="radio">手动填写</label>
                    <div class="gitee-fields parts-fields inactive" data-gitee-mode-panel="parts">
                        <label>码云用户名<input data-field="gitee_user" data-persist-key="create.gitee_user" type="text" placeholder="XXX" disabled></label>
                        <label>码云仓库名<input data-field="gitee_repository" data-persist-key="create.gitee_repository" type="text" placeholder="XXX" disabled></label>
                        <label>码云网址前缀<input data-field="gitee_url" data-persist-key="create.gitee_url" type="text" placeholder="https://XXX 前缀或者 git@XXX 前缀" disabled></label>
                    </div>
                </div>
                <div class="form-row two-fields branch-row">
                    <label>码云分支<input data-field="gitee_branch" data-persist-key="create.gitee_branch" type="text" placeholder="master"></label>
                    <label class="check-button form-check"><input data-field="authorize_general_account" data-persist-key="create.authorize_general_account" type="checkbox">授权使用 TestAgent Cloud 通用码云账户</label>
                </div>
                <div class="form-row single-field">
                    <label>镜像${renderStyledSelect('data-field="image" data-persist-key="create.image"', renderImageOptions(images, defaultImage))}</label>
                </div>
                <div class="form-row single-field">
                    <label>有效期 (小时)<input data-field="expiration_hours" data-persist-key="create.expiration_hours" type="number" min="0" step="1" placeholder="0 表示该容器永不过期"></label>
                </div>
                <div class="form-row two-fields">
                    <label>CPU (核)<input data-field="cpu" data-persist-key="create.cpu" type="number" min="0.01" step="0.01" placeholder="2"></label>
                    <label>内存 (Gi)<input data-field="memory" data-persist-key="create.memory" type="number" min="1" step="1" placeholder="2"></label>
                </div>
                <div class="form-actions"><button class="primary-button" type="button" data-action="createContainer">创建容器</button></div>
            </div>
        </details>
        ${renderSearchBox('搜索容器...', search)}
        ${renderListControls('containers')}
        <div class="resource-list container-list" data-resource-list><div class="resource-items" data-resource-items>${rows}</div>${empty}${emptySearch}</div>
    </section>`;
}

function renderImageOptions(images: ImageListItem[], defaultImage: string | null): SelectOption[] {
    const usableImages = images
        .filter(image => image.status.toLowerCase() === 'pushed' || image.status.toLowerCase() === 'default' || image.full_name === defaultImage)
        .sort((left, right) => {
            const leftDefault = left.full_name === defaultImage || !defaultImage && left.status.toLowerCase() === 'default';
            const rightDefault = right.full_name === defaultImage || !defaultImage && right.status.toLowerCase() === 'default';
            return leftDefault === rightDefault ? left.full_name.localeCompare(right.full_name) : leftDefault ? -1 : 1;
        });
    const statusDefault = usableImages.find(image => image.status.toLowerCase() === 'default');
    const hasDefault = Boolean(defaultImage && usableImages.some(image => image.full_name === defaultImage) || !defaultImage && statusDefault);
    const options: SelectOption[] = [];
    if (!defaultImage && !statusDefault) {
        options.push({ value: '', label: '请选择一个镜像', selected: true, disabled: true });
    }
    const missingDefault = defaultImage && !hasDefault
        ? { value: defaultImage, label: '默认镜像 (镜像不存在)', selected: true }
        : undefined;
    if (missingDefault) {
        options.push(missingDefault);
    }
    options.push(...usableImages.map(image => {
        const isDefault = image.full_name === defaultImage || !defaultImage && image.status.toLowerCase() === 'default';
        return {
            value: image.full_name,
            label: `${image.full_name}${isDefault ? ' (默认镜像)' : ''}`,
            selected: isDefault,
        };
    }));
    return options;
}

function renderStats(stats: AdminStateResponse | undefined, limit: ContainerLimitResponse | undefined, orphanContainerIds: string[]): string {
    if (!stats) {
        return '';
    }
    return `<div class="stats-grid service-stats">
        ${statCard('全部容器总数', `${stats.container_count}/${formatContainerLimit(limit)}`)}
        ${renderOrphanCard(orphanContainerIds)}
        ${statCard('白名单容器总数', stats.whitelist_container_count)}
        ${statCard('管理员容器总数', stats.admin_container_count)}
    </div>
    <div class="stats-grid people-stats">
        ${statCard('白名单用户', stats.whitelist_count)}
        ${statCard('管理员用户', stats.admin_count)}
    </div>`;
}

function renderOrphanCard(orphanContainerIds: string[]): string {
    const count = orphanContainerIds.length;
    return `<div class="stat-card overview-card orphan-card"><span>孤儿容器总数</span><div class="orphan-card-value"><strong>${count}</strong><button class="small-button danger-button" type="button" data-action="deleteOrphanContainers" data-orphan-container-ids="${escapeAttribute(orphanContainerIds.join(','))}"${count ? '' : ' disabled'}>全部删除</button></div></div>`;
}

function statCard(label: string, value: number | string): string {
    return `<div class="stat-card overview-card"><span>${label}</span><strong>${value}</strong></div>`;
}

function formatContainerLimit(limit: ContainerLimitResponse | undefined): string {
    if (!limit) {
        return '--';
    }
    return limit.container_limit === 0 ? '无限制' : String(limit.container_limit);
}

function renderLimitForm(limit: ContainerLimitResponse | undefined): string {
    return `<div class="limit-card overview-card" data-patch-key="limit-card" data-form="setLimit"><div><h3>全局资源限制</h3><p>数量为 0 表示无限制</p></div>
        <label>可用容器数量限制<input data-field="container_limit" data-persist-key="limit.container_limit" type="number" min="0" step="1" value="${limit?.container_limit ?? ''}"></label>
        <label>CPU (当前值: ${formatResourceLimit(limit?.cpu, '核')})<input data-field="cpu" data-persist-key="limit.cpu" type="number" min="0.01" step="0.01" value="${limit?.cpu ?? ''}"></label>
        <label>内存 (当前值: ${formatResourceLimit(limit?.memory, 'Gi')})<input data-field="memory" data-persist-key="limit.memory" type="number" min="1" step="1" value="${limit?.memory ?? ''}"></label>
        <button class="tonal-button" type="button" data-action="setLimit">保存</button>
    </div>`;
}

function formatResourceLimit(value: number | undefined, unit: string): string {
    return typeof value === 'number' && Number.isFinite(value) ? `${value} ${unit}` : '--';
}

function renderSearchBox(placeholder: string, value = ''): string {
    return `<div class="search-panel">
        <div class="search-box" role="search">
            <span class="search-icon" aria-hidden="true"></span>
            <input data-search-input type="search" value="${escapeAttribute(value)}" placeholder="${escapeAttribute(placeholder)}" autocomplete="off">
        </div>
    </div>`;
}

function renderListControls(kind: 'images' | 'containers' | 'users', stateKey: string = kind): string {
    const options: Array<[string, string]> = kind === 'images'
        ? [['name', '名称'], ['status', '状态'], ['size', '大小'], ['created', '创建时间']]
        : kind === 'containers'
            ? [['container_id', '容器 ID'], ['user_id', '用户 ID'], ['status', '状态'], ['created_at', '创建时间']]
            : [['user_id', '用户 ID']];
    const statusOptions = kind === 'images'
        ? [['not_pushed', '未推送'], ['pushed', '已推送'], ['default', '默认镜像']]
        : [['running', '运行中'], ['pending', '准备中'], ['stopped', '已停止'], ['failed', '已失败'], ['business_deleted', '业务删除'], ['unknown', '未知状态']];
    const sortOptions = options.map(([value, label]) => ({ value, label }));
    const statusSelectOptions: SelectOption[] = [['all', '全部状态'], ...statusOptions].map(([value, label]) => ({ value, label }));
    return `<div class="list-controls" data-list-controls data-list-kind="${stateKey}" data-default-sort="${options[0][0]}">
        <label class="control-inline"><span>排列依据</span>${renderStyledSelect('data-sort-select', sortOptions)}</label>
        <div class="direction-control"><span>排序顺序</span><button class="small-button sort-toggle" type="button" data-sort-toggle><span data-sort-arrow aria-hidden="true">↑</span><span data-sort-label>升序</span></button></div>
        ${kind === 'users' ? '' : `<label class="control-inline"><span>状态过滤</span>${renderStyledSelect('data-status-filter', statusSelectOptions)}</label>`}
        <label class="control-inline"><span>每页数目</span>${renderStyledSelect('data-page-size', [{ value: '10', label: '10' }, { value: '20', label: '20', selected: true }, { value: '50', label: '50' }])}</label>
        <div class="pagination"><button class="small-button" type="button" data-page-action="previous" disabled>上一页</button><span data-page-indicator>第 1/1 页 · 共 0 项</span><button class="small-button" type="button" data-page-action="next" disabled>下一页</button></div>
    </div>`;
}

function renderStyledSelect(attributes: string, options: SelectOption[]): string {
    const selected = options.find(option => option.selected) ?? options[0];
    const nativeOptions = options.map(option => `<option value="${escapeAttribute(option.value)}"${option.selected ? ' selected' : ''}${option.disabled ? ' disabled' : ''}>${escapeHtml(option.label)}</option>`).join('');
    const menuOptions = options.map(option => `<button class="select-option${option.selected ? ' selected' : ''}" type="button" role="option" data-select-option data-select-value="${escapeAttribute(option.value)}" aria-selected="${option.selected ? 'true' : 'false'}"${option.disabled ? ' disabled' : ''}>${escapeHtml(option.label)}</button>`).join('');
    return `<span class="select-wrap custom-select" data-custom-select>
        <button class="select-trigger" type="button" data-select-trigger aria-haspopup="listbox" aria-expanded="false"><span data-select-label>${escapeHtml(selected?.label ?? '')}</span><span class="select-trigger-arrow" aria-hidden="true"></span></button>
        <select class="native-select" ${attributes}>${nativeOptions}</select>
        <span class="select-menu" data-select-menu role="listbox">${menuOptions}</span>
    </span>`;
}

function renderContainerRow(container: AdminContainerResponse): string {
    const deleted = container.business_deleted;
    const status = deleted ? 'business_deleted' : container.status.toLowerCase();
    const statusStyle = statusClass(status);
    const transitioning = isContainerTransitioning(status);
    const rowClasses = ['resource-row', 'container-row', 'searchable', `status-border-${statusStyle}`, deleted ? 'deleted-row' : ''].filter(Boolean).join(' ');
    const lifecycle = deleted
        ? { label: '删除时间', value: formatDateTime(container.deleted_at) || '未删除' }
        : { label: '删除时间 (计划)', value: container.expires_at ? formatDateTime(container.expires_at) : '永不过期' };
    const searchText = [
        container.container_id,
        container.user_id,
        container.image,
        status,
        containerStatusLabel(container.status, deleted),
        container.gitee_user,
        container.gitee_repository,
        container.gitee_branch ?? '',
        container.gitee_url,
    ].join(' ');
    return `<article class="${rowClasses}" data-patch-key="container:${escapeAttribute(container.container_id)}" data-search-text="${escapeAttribute(searchText)}" data-filter-status="${escapeAttribute(status)}" data-sort-container_id="${escapeAttribute(container.container_id)}" data-sort-status="${escapeAttribute(status)}" data-sort-user_id="${escapeAttribute(container.user_id)}" data-sort-created_at="${escapeAttribute(container.created_at)}">
        <div class="container-card-heading">
            <div class="container-identity"><div class="resource-main"><div class="container-title"><strong>${escapeHtml(container.container_id)}</strong><span class="status-chip tag ${statusStyle}${transitioning ? ' status-transitioning' : ''}">${escapeHtml(containerStatusLabel(container.status, deleted))}</span></div><span>镜像: ${escapeHtml(container.image)}</span></div></div>
            <button class="small-button log-button" type="button" data-action="getContainerLog" data-container-id="${escapeAttribute(container.container_id)}">日志</button>
        </div>
        <div class="container-details">
            <div class="container-info-row">
                ${containerDetail('用户 ID', container.user_id)}
                ${containerDetail('访问端点', container.endpoint ?? '未分配')}
            </div>
            <div class="container-info-row">
                ${containerDetail('码云信息', formatGitee(container))}
                ${containerDetail('授权使用通用码云账户', container.authorize_general_account ? '是' : '否')}
            </div>
            <div class="container-info-row">
                ${containerDetail('启动时间', formatDateTime(container.started_at) || '未启动')}
                ${containerDetail(lifecycle.label, lifecycle.value)}
            </div>
            <div class="container-info-row">
                ${containerDetail('CPU 占用', formatMetric(container.cpu_usage), getMetricClass(container.cpu_usage))}
                ${containerDetail('内存占用', formatMetric(container.memory_usage), getMetricClass(container.memory_usage))}
            </div>
        </div>
        <div class="container-actions">
            ${deleted
                ? `<div class="container-operation-row"><button class="small-button danger-button" type="button" data-action="containerAction" data-container-id="${escapeAttribute(container.container_id)}" data-container-action="permanent-delete">永久删除</button></div><div class="container-expiration-row"><input class="inline-number" data-field="expirationHours" data-persist-key="container.${escapeAttribute(container.container_id)}.expirationHours" type="number" min="0" step="1" placeholder="有效期 (小时)"><button class="small-button" type="button" data-action="containerAction" data-container-id="${escapeAttribute(container.container_id)}" data-container-action="restore">立即恢复</button></div>`
                : `<div class="container-operation-row">${containerActionButton(container, 'start', '启动')}${containerActionButton(container, 'stop', '停止')}${containerActionButton(container, 'restart', '重启')}<button class="small-button danger-button" type="button" data-action="containerAction" data-container-id="${escapeAttribute(container.container_id)}" data-container-action="delete"${transitioning ? ' disabled' : ''}>业务删除</button><button class="small-button danger-button" type="button" data-action="containerAction" data-container-id="${escapeAttribute(container.container_id)}" data-container-action="permanent-delete"${transitioning ? ' disabled' : ''}>永久删除</button></div><div class="container-expiration-row"><input class="inline-number" data-field="expirationHours" data-persist-key="container.${escapeAttribute(container.container_id)}.expirationHours" type="number" min="0" step="1" placeholder="有效期 (小时)"${transitioning ? ' disabled' : ''}><button class="small-button" type="button" data-action="containerAction" data-container-id="${escapeAttribute(container.container_id)}" data-container-action="expiration"${transitioning ? ' disabled' : ''}>设置有效期</button></div>`}
        </div>
    </article>`;
}

function containerDetail(label: string, value: string, className = ''): string {
    return `<div class="detail-item${className ? ` ${className}` : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderLogModal(): string {
    return `<div class="log-modal" data-patch-key="log-modal" data-log-modal hidden>
        <section class="log-dialog" role="dialog" aria-modal="true" aria-labelledby="container-log-title">
            <header class="log-dialog-header">
                <div><span class="log-dialog-label">容器日志</span><strong id="container-log-title" data-log-title>未选择容器</strong></div>
                <div class="log-dialog-actions"><button class="small-button" type="button" data-action="getContainerLog" data-container-id="" data-log-refresh>刷新</button><button class="small-button" type="button" data-action="closeContainerLog">关闭</button></div>
            </header>
            <pre class="log-content" data-log-content>正在加载日志...</pre>
        </section>
    </div>`;
}

function containerActionButton(container: AdminContainerResponse, action: string, label: string): string {
    const status = container.status.toLowerCase();
    const disabled = isContainerTransitioning(status)
        || action === 'start' && (status === 'running' || status === 'pending')
        || action === 'stop' && (status === 'stopped' || status === 'failed')
        || action === 'restart' && status === 'failed';
    return `<button class="small-button" type="button" data-action="containerAction" data-container-id="${escapeAttribute(container.container_id)}" data-container-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
}

function renderUsersTab(kind: 'whitelist' | 'admin', title: string, users: string[], search = ''): string {
    const addAction = kind === 'whitelist' ? 'addWhitelistUser' : 'addAdminUser';
    const deleteAction = kind === 'whitelist' ? 'deleteWhitelistUser' : 'deleteAdminUser';
    const rows = users.map(userId => `<article class="resource-row searchable" data-patch-key="${kind}-user:${escapeAttribute(userId)}" data-search-text="${escapeAttribute(userId)}" data-sort-user_id="${escapeAttribute(userId)}"><div class="resource-main"><strong>${escapeHtml(userId)}</strong><span>${kind === 'whitelist' ? '白名单用户' : '管理员用户'}</span></div><button class="small-button danger-button" type="button" data-action="${deleteAction}" data-user-id="${escapeAttribute(userId)}">删除</button></article>`).join('');
    const emptySearch = users.length ? '<p class="empty-message" data-empty-search hidden>没有匹配的用户</p>' : '';
    return `<section class="tab-panel" data-tab-panel data-patch-key="tab-${kind}" aria-labelledby="${kind}-tab">
        <div class="section-heading"><h2 id="${kind}-tab">${title} <span class="count-badge tag">${users.length} 位</span></h2></div>
        <details class="inline-form user-form collapsible-card" data-form="${kind}User" open>
            <summary class="collapsible-summary"><strong>添加用户</strong><span>添加新的${title}</span><span class="collapse-chevron" aria-hidden="true"></span></summary>
            <div class="user-form-body">
                <label>用户 ID<input data-field="user_id" data-persist-key="${kind}.user_id" type="text" placeholder="10001"></label>
                <button class="primary-button" type="button" data-action="${addAction}">添加</button>
            </div>
        </details>
        ${renderSearchBox(`搜索${title}...`, search)}
        ${renderListControls('users', kind)}
        <div class="resource-list user-list" data-resource-list><div class="resource-items" data-resource-items>${rows}</div>${rows ? '' : '<p class="empty-message" data-empty-data>暂无用户数据</p>'}${emptySearch}</div>
    </section>`;
}

function imageStatusLabel(status: string): string {
    switch (status) {
        case 'not_pushed': return '未推送';
        case 'pushed': return '已推送';
        case 'default': return '默认镜像';
        default: return status || '未知状态';
    }
}

function containerStatusLabel(status: string, deleted: boolean): string {
    if (deleted) {
        return '业务删除';
    }
    switch (status.toLowerCase()) {
        case 'running': return '运行中';
        case 'stopped': return '已停止';
        case 'failed': return '已失败';
        case 'pending': return '准备中';
        case 'starting': return '启动中';
        case 'stopping': return '停止中';
        case 'restarting': return '重启中';
        case 'deleting': return '操作中';
        case 'restoring': return '操作中';
        case 'unknown': return '未知状态';
        default: return status || '未知状态';
    }
}

function statusClass(status: string): string {
    switch (status.toLowerCase()) {
        case 'running':
        case 'pushed': return 'success';
        case 'stopped':
        case 'failed':
        case 'not_pushed': return 'warning';
        case 'default': return 'primary';
        case 'unknown': return 'error';
        case 'business_deleted': return 'error';
        case 'pending':
        case 'starting':
        case 'stopping':
        case 'restarting':
        case 'deleting': return 'warning';
        case 'restoring': return 'warning';
        default: return 'neutral';
    }
}

function isContainerTransitioning(status: string): boolean {
    return ['pending', 'starting', 'stopping', 'restarting', 'deleting', 'restoring'].includes(status.toLowerCase());
}

function formatGitee(container: AdminContainerResponse): string {
    const values = [container.gitee_user, container.gitee_repository].filter(Boolean);
    if (!values.length) {
        return '未配置';
    }
    const repository = values.join('/');
    const branch = container.gitee_branch?.trim();
    return branch ? `${repository} (${branch})` : repository;
}

function formatMetric(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '--';
}

function getMetricClass(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'usage-metric-unavailable';
    }
    if (value >= 90) {
        return 'usage-metric-critical';
    }
    if (value >= 75) {
        return 'usage-metric-warning';
    }
    return 'usage-metric-low';
}

function formatDateTime(value: string | null | undefined): string {
    if (!value?.trim()) {
        return '';
    }
    const text = value.trim();
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    const hasTime = /T|\s\d{2}:\d{2}/.test(text);
    const date = new Date(hasTimezone ? text : `${text}${hasTime ? '' : 'T00:00:00'}+08:00`);
    if (Number.isNaN(date.getTime())) {
        return text;
    }
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type: string): string => parts.find(item => item.type === type)?.value ?? '';
    return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
}

function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
        return '--';
    }
    if (value < 1024) {
        return `${value} B`;
    }
    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KiB`;
    }
    if (value < 1024 * 1024 * 1024) {
        return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    }
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value: unknown): string {
    return escapeHtml(value);
}

const ADMIN_CSS = String.raw`
:root {
    color-scheme: light dark;
    --surface: var(--vscode-editor-background, #1e1e1e);
    --surface-raised: var(--vscode-sideBar-background, #252526);
    --surface-soft: var(--vscode-textCodeBlock-background, #2a2d2e);
    --text: var(--vscode-foreground, #cccccc);
    --muted: var(--vscode-descriptionForeground, #9da0a6);
    --outline: var(--vscode-panel-border, #454545);
    --primary: var(--vscode-button-background, #0e639c);
    --primary-text: var(--vscode-button-foreground, #ffffff);
    --primary-hover: var(--vscode-button-hoverBackground, #1177bb);
    --danger: var(--vscode-testing-iconFailed, #f14c4c);
    --warning: var(--vscode-editorWarning-foreground, #cca700);
    --success: var(--vscode-testing-iconPassed, #73c991);
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; color: var(--text); background: var(--surface); font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: 12px; line-height: 1.45; }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
.admin-shell { max-width: 1440px; margin: 0 auto; padding: 24px clamp(16px, 4vw, 56px) 52px; }
.page-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
.page-header h1 { margin: 0; font-size: 26px; letter-spacing: -.02em; }
h1, h2, h3, p { margin-top: 0; }
h2 { margin: 0; font-size: 20px; letter-spacing: -.01em; }
h3 { margin: 0 0 5px; font-size: 14px; }
.section-heading { margin: 22px 0 14px; }
.section-heading h2 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.tab-bar { display: flex; gap: 5px; overflow-x: auto; border-bottom: 1px solid var(--outline); }
.tab-button { min-height: 40px; padding: 0 16px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; font-size: 12px; white-space: nowrap; transition: color .16s ease, background-color .16s ease, border-color .16s ease; }
.tab-button:hover, .tab-button.active { color: var(--text); background: var(--surface-soft); }
.tab-button.active { border-bottom-color: var(--primary); font-weight: 700; }
.tab-panel { min-width: 0; animation: panel-enter .22s ease both; }
.overview-card, .default-banner, .inline-form, .form-card, .limit-card, .image-upload-card, .resource-row { border: 1px solid var(--outline); border-radius: 12px; background: var(--surface-raised); transition: border-color .18s ease, background-color .18s ease, box-shadow .18s ease, transform .18s ease; }
.resource-row:hover { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(0, 0, 0, .18); }
.stats-grid { display: grid; gap: 10px; margin-bottom: 10px; }
.service-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.people-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.stat-card { display: flex; align-items: center; justify-content: space-between; min-height: 64px; padding: 12px 14px; }
.stat-card span { color: var(--muted); }
.stat-card strong { font-size: 18px; font-weight: 700; }
.service-stats .stat-card:first-child strong { font-size: 16px; }
.orphan-card-value { display: flex; align-items: center; gap: 8px; }
.orphan-card-value .small-button { min-height: 28px; padding: 0 9px; }
.default-banner { min-height: 64px; justify-content: flex-start; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; padding: 12px 14px; border-color: var(--outline); }
.default-banner.warning { border-color: var(--warning); background: var(--surface-soft); }
.default-banner.danger { border-color: var(--danger); background: var(--surface-soft); box-shadow: 0 0 0 1px var(--danger); }
.default-banner.danger .default-image-name { color: var(--danger); }
.default-image-copy { min-width: 0; flex: 1 1 auto; }
.default-image-line { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.default-label { flex: 0 0 auto; color: var(--muted); font-size: 11px; font-weight: 600; }
.default-image-name { min-width: 0; overflow: hidden; color: var(--text); font-size: 13px; font-weight: 600; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
label { display: flex; flex-direction: column; gap: 6px; color: var(--muted); font-size: 11px; }
input, select { min-height: 35px; padding: 6px 9px; border: 1px solid var(--outline); border-radius: 8px; color: var(--text); background: var(--surface); outline: 0; }
input:focus, select:focus { border-color: var(--primary); }
input[type="checkbox"], input[type="radio"] { width: 15px; height: 15px; min-height: 15px; margin: 0; padding: 0; accent-color: var(--primary); }
.tag, .count-badge { display: inline-flex; align-items: center; min-height: 23px; padding: 2px 8px; border: 1px solid var(--outline); border-radius: 999px; background: var(--surface-soft); color: var(--muted); font-size: 11px; font-weight: 500; white-space: nowrap; }
.warning-tag { border-color: var(--warning); color: var(--warning); }
.danger-tag { border-color: var(--danger); color: var(--danger); }
.status-chip.success { border-color: currentColor; color: var(--success); }
.status-chip.warning { border-color: currentColor; color: var(--warning); }
.status-chip.status-transitioning { animation: operation-pulse 1.2s ease-in-out infinite; }
.status-chip.error { border-color: currentColor; color: var(--danger); }
.status-chip.primary { border-color: currentColor; color: var(--primary-hover); }
.status-chip.neutral { border-color: var(--outline); color: var(--muted); }
.inline-form { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; padding: 14px; }
.inline-form label { flex: 1 1 240px; }
.primary-button, .tonal-button, .small-button { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; padding: 0 13px; border: 1px solid transparent; border-radius: 8px; color: var(--primary-text); background: var(--primary); white-space: nowrap; transition: border-color .16s ease, background-color .16s ease, color .16s ease, transform .16s ease; }
.primary-button:hover { background: var(--primary-hover); }
.tonal-button, .small-button { color: var(--text); border-color: var(--outline); background: var(--surface-soft); }
.tonal-button:hover, .small-button:hover { border-color: var(--primary); }
.primary-button:not(:disabled):hover, .tonal-button:not(:disabled):hover, .small-button:not(:disabled):hover { transform: translateY(-1px); }
.danger-button { color: var(--danger); }
.limit-card { display: grid; grid-template-columns: minmax(220px, 1.4fr) repeat(3, minmax(100px, 1fr)) auto; align-items: center; gap: 12px; margin-bottom: 20px; padding: 14px; }
.limit-card > div { display: flex; flex-direction: column; justify-content: center; align-self: stretch; }
.limit-card p { margin-bottom: 0; color: var(--muted); font-size: 11px; }
.limit-card .tonal-button { min-width: 112px; min-height: 40px; padding: 0 18px; }
.select-wrap { position: relative; display: block; min-width: 0; border: 1px solid var(--outline); border-radius: 10px; background: var(--surface); transition: border-color .15s ease, box-shadow .15s ease; }
.select-wrap:hover { border-color: var(--primary); }
.select-wrap:focus-within { border-color: var(--primary); box-shadow: 0 0 0 2px var(--surface-soft); }
.select-wrap select { width: 100%; min-height: 35px; appearance: none; padding: 6px 32px 6px 11px; border: 0; border-radius: 9px; background: transparent; font-weight: 500; cursor: pointer; }
.select-wrap select:focus { border: 0; }
.select-wrap::after { position: absolute; top: 50%; right: 11px; width: 6px; height: 6px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; color: var(--muted); content: ''; pointer-events: none; transform: translateY(-65%) rotate(45deg); }
.custom-select {
    --select-background: var(--surface-raised);
    --select-foreground: var(--text);
    --select-border: var(--outline);
    --select-hover-background: var(--surface-soft);
    --select-selected-background: var(--primary);
    --select-selected-foreground: var(--primary-text);
    --select-focus: var(--primary);
    border: 0;
    background: transparent;
}
.custom-select:hover, .custom-select:focus-within { border-color: transparent; box-shadow: none; }
.custom-select::after { display: none; }
.custom-select .native-select { position: absolute; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; pointer-events: none; }
.select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 37px; padding: 0 11px 0 12px; border: 1px solid var(--select-border); border-radius: 10px; color: var(--select-foreground); background: var(--select-background); font-size: 12px; font-weight: 600; text-align: left; }
.select-trigger:hover { border-color: var(--select-focus); background: var(--select-hover-background); }
.select-trigger:focus-visible { border-color: var(--select-focus); outline: 2px solid var(--select-focus); outline-offset: 1px; }
[data-select-label] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.select-trigger-arrow { flex: 0 0 8px; width: 8px; height: 8px; border-right: 1.5px solid var(--select-foreground); border-bottom: 1.5px solid var(--select-foreground); transform: translateY(-2px) rotate(45deg); }
.custom-select.open .select-trigger-arrow { transform: translateY(2px) rotate(225deg); }
.select-menu { position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; display: grid; grid-template-columns: 1fr; gap: 3px; width: 100%; min-width: 130px; max-height: 250px; overflow-y: auto; padding: 5px; border: 1px solid var(--select-border); border-radius: 10px; background: var(--select-background); box-shadow: 0 10px 24px var(--surface); opacity: 0; pointer-events: none; transform: translateY(-4px); visibility: hidden; transition: opacity .14s ease, transform .14s ease, visibility .14s ease; }
.custom-select.open .select-menu { opacity: 1; pointer-events: auto; transform: translateY(0); visibility: visible; }
.select-option { width: 100%; min-height: 32px; padding: 0 9px; border: 0; border-radius: 7px; color: var(--select-foreground); background: var(--select-background); font-size: 12px; text-align: left; white-space: nowrap; }
.select-option:hover, .select-option.selected { color: var(--select-selected-foreground); background: var(--select-selected-background); }
.select-option:disabled { color: var(--muted); background: var(--select-background); cursor: not-allowed; }
.collapsible-card { overflow: hidden; }
.form-card.collapsible-card { overflow: visible; }
.image-upload-card { width: 100%; margin-bottom: 14px; }
.collapsible-card > summary { list-style: none; }
.collapsible-card > summary::-webkit-details-marker { display: none; }
.collapsible-summary { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 18px; cursor: pointer; }
.collapsible-summary strong { font-size: 14px; }
.collapsible-summary > span:not(.collapse-chevron) { color: var(--muted); }
.collapse-chevron { width: 8px; height: 8px; margin-left: auto; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; color: var(--muted); transform: rotate(45deg); transition: transform .15s ease; }
.collapsible-card[open] .collapse-chevron { transform: translateY(2px) rotate(225deg); }
.upload-body, .create-form-body { border-top: 1px solid var(--outline); }
.upload-body { display: grid; gap: 18px; padding: 18px 20px 20px; }
.upload-file-row { display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 12px; }
.selected-file { max-width: min(100%, 520px); overflow-wrap: anywhere; color: var(--muted); }
.upload-target-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; width: 100%; margin: 0 auto; }
.upload-target-row input { text-align: left; }
.upload-actions-row { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.check-button { display: inline-flex; flex-direction: row; align-items: center; gap: 7px; min-height: 34px; padding: 0 11px; border: 1px solid var(--outline); border-radius: 8px; color: var(--text); background: var(--surface-soft); cursor: pointer; white-space: nowrap; }
.check-button:hover { border-color: var(--primary); }
.check-button.disabled { opacity: .55; cursor: not-allowed; }
.check-button.disabled:hover { border-color: var(--outline); }
.form-card { margin-bottom: 18px; }
.inline-form.collapsible-card { display: block; padding: 0; }
.user-form-body { display: flex; align-items: end; gap: 12px; padding: 14px; border-top: 1px solid var(--outline); }
.user-form-body label { flex: 1 1 240px; }
.user-form-body .primary-button { flex: 0 0 auto; }
.create-form-body { width: min(100%, 1000px); margin: 0 auto; padding: 17px 20px 20px; }
.form-note { margin-bottom: 17px; color: var(--muted); }
.form-row { display: grid; gap: 12px; margin-bottom: 13px; }
.single-field { grid-template-columns: minmax(0, 1fr); }
.two-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.branch-row { width: 100%; grid-template-columns: minmax(0, 3fr) minmax(190px, 1fr); }
.gitee-option-row { display: grid; grid-template-columns: 150px minmax(0, 1fr); align-items: center; gap: 12px; margin-bottom: 13px; }
.mode-radio { display: flex; flex-direction: row; align-items: center; gap: 7px; min-height: 35px; color: var(--text); cursor: pointer; }
.gitee-fields { min-width: 0; }
.mode-description { display: flex; align-items: center; min-height: 35px; color: var(--muted); }
.parts-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.gitee-fields.inactive { opacity: .58; }
.gitee-fields.inactive input { cursor: not-allowed; }
.form-check { width: 100%; align-self: end; justify-self: stretch; }
.form-actions { display: flex; justify-content: flex-end; margin-top: 4px; }
.search-panel { display: flex; align-items: center; gap: 9px; width: 100%; margin: 0 0 13px; }
.search-box { display: flex; flex-direction: row; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; padding: 0 13px; border: 1px solid var(--outline); border-radius: 9px; background: var(--surface-raised); color: var(--muted); }
.search-box input { width: 100%; min-height: 38px; border: 0; outline: 0; color: var(--text); background: transparent; }
.search-icon { position: relative; display: inline-block; flex: 0 0 14px; width: 14px; height: 14px; border: 2px solid currentColor; border-radius: 50%; }
.search-icon::after { position: absolute; right: -5px; bottom: -3px; width: 6px; height: 2px; border-radius: 2px; background: currentColor; content: ''; transform: rotate(45deg); transform-origin: left center; }
.list-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; padding: 9px 10px; border: 1px solid var(--outline); border-radius: 10px; background: var(--surface-raised); }
.control-inline, .direction-control { display: flex; flex-direction: row; align-items: center; gap: 7px; min-height: 35px; white-space: nowrap; }
.control-inline > span:first-child, .direction-control > span:first-child { color: var(--muted); }
.control-inline .select-wrap { width: 130px; }
.direction-control { color: var(--muted); }
.sort-toggle { gap: 6px; color: var(--text); border-color: var(--outline); background: var(--surface-soft); }
.sort-toggle [data-sort-arrow] { color: var(--primary-hover); font-size: 14px; line-height: 1; }
.pagination { display: flex; align-items: center; gap: 7px; margin-left: auto; color: var(--muted); font-size: 11px; }
.resource-list { display: block; }
.resource-items { display: grid; gap: 10px; }
.resource-items[hidden], .resource-row[hidden], .empty-message[hidden] { display: none !important; }
.resource-row { min-width: 0; padding: 14px; }
.user-list .resource-row { display: flex; align-items: center; gap: 12px; }
.user-list .resource-main { flex: 1 1 auto; }
.resource-main { display: grid; flex: 1 1 220px; gap: 4px; min-width: 0; }
.resource-main strong { overflow-wrap: anywhere; font-size: 13px; }
.resource-main span { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.image-row { display: flex; align-items: center; flex-wrap: nowrap; gap: 14px; }
.image-row .resource-main { flex: 1 1 auto; min-width: 0; }
.image-title { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; }
.image-title strong { min-width: 0; overflow-wrap: anywhere; }
.image-size { color: var(--muted); }
.row-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
.image-row .row-actions { flex: 0 0 auto; }
.row-check { font-size: 11px; }
.container-row { display: grid; gap: 15px; }
.container-card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
.container-identity { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
.container-identity .resource-main { flex: 1 1 auto; }
.container-identity .resource-main strong { font-size: 14px; }
.container-title { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; }
.container-title strong { min-width: 0; overflow-wrap: anywhere; }
.log-button { flex: 0 0 auto; color: var(--primary-hover); }
.container-details { display: grid; gap: 8px; }
.container-info-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 8px; }
.detail-item { display: grid; gap: 3px; min-width: 0; padding: 8px 9px; border: 1px solid var(--outline); border-radius: 8px; background: var(--surface); }
.detail-item span { color: var(--muted); font-size: 10px; }
.detail-item strong { min-width: 0; overflow-wrap: anywhere; font-size: 11px; font-weight: 500; }
.usage-metric-low span, .usage-metric-low strong { color: var(--vscode-testing-iconPassed, #3fb950); }
.usage-metric-warning span, .usage-metric-warning strong { color: var(--vscode-editorWarning-foreground, #e5c07b); }
.usage-metric-critical span, .usage-metric-critical strong { color: var(--vscode-errorForeground, #f28b82); }
.usage-metric-unavailable span, .usage-metric-unavailable strong { color: var(--text); }
.container-actions { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--outline); }
.container-operation-row, .container-expiration-row { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 7px; }
.container-expiration-row { padding-top: 0; }
.deleted-row { border-color: var(--danger); }
.container-row.status-border-success { border-color: var(--success); }
.container-row.status-border-warning { border-color: var(--warning); }
.container-row.status-border-error { border-color: var(--danger); }
.container-row.status-border-primary { border-color: var(--primary-hover); }
.container-row.status-border-neutral { border-color: var(--outline); }
.inline-number { width: 130px; min-height: 32px; }
.empty-message { padding: 26px; border: 1px dashed var(--outline); border-radius: 10px; color: var(--muted); text-align: center; }
.log-modal { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(0 0 0 / 45%); }
.log-modal[hidden] { display: none; }
.log-dialog { display: grid; grid-template-rows: auto minmax(260px, 1fr); width: min(100%, 900px); max-height: min(80vh, 720px); overflow: hidden; border: 1px solid var(--outline); border-radius: 14px; background: var(--surface-raised); box-shadow: 0 16px 40px rgb(0 0 0 / 28%); }
.log-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--outline); }
.log-dialog-label { display: block; margin-bottom: 3px; color: var(--muted); font-size: 11px; }
.log-dialog-header strong { overflow-wrap: anywhere; font-size: 14px; }
.log-dialog-actions { display: flex; align-items: center; gap: 7px; }
.log-content { min-height: 260px; margin: 0; overflow: auto; padding: 16px; color: var(--text); background: var(--surface); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.status-page { display: grid; place-items: center; min-height: 100vh; padding: 24px; background: var(--surface); }
.status-card { width: min(100%, 480px); padding: 30px; text-align: center; }
.status-card h1 { font-size: 22px; }
.status-card p { color: var(--muted); line-height: 1.6; white-space: pre-line; }
.status-icon { display: inline-grid; place-items: center; width: 34px; height: 34px; margin-bottom: 15px; border-radius: 50%; color: var(--primary-text); background: var(--danger); font-weight: 700; }
.spinner { display: inline-block; width: 24px; height: 24px; margin-bottom: 18px; border: 3px solid var(--outline); border-top-color: var(--primary); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes panel-enter { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
@keyframes operation-pulse { 50% { opacity: .52; } }
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
}
@media (max-width: 980px) {
    .limit-card { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .limit-card > div { grid-column: 1 / -1; }
    .limit-card .tonal-button { justify-self: end; }
    .image-row { align-items: flex-start; flex-wrap: wrap; }
    .image-row .row-actions { flex: 1 1 100%; justify-content: flex-start; }
    .gitee-option-row { grid-template-columns: 130px minmax(0, 1fr); }
}
@media (max-width: 700px) {
    .admin-shell { padding: 20px 14px 38px; }
    .page-header h1 { font-size: 23px; }
    .service-stats, .people-stats { grid-template-columns: 1fr; }
    .collapsible-summary { align-items: flex-start; flex-wrap: wrap; padding: 13px 15px; }
    .collapsible-summary > span:not(.collapse-chevron) { flex: 1 1 100%; order: 3; }
    .collapse-chevron { margin-top: 4px; }
    .gitee-option-row { grid-template-columns: 1fr; gap: 6px; }
    .parts-fields, .upload-target-row { grid-template-columns: 1fr; }
    .two-fields { grid-template-columns: 1fr; }
    .container-info-row { grid-template-columns: 1fr; }
    .form-check { justify-self: start; }
    .container-operation-row, .container-expiration-row { justify-content: stretch; }
    .container-expiration-row .inline-number, .container-expiration-row .small-button { flex: 1 1 100%; width: 100%; }
    .upload-actions-row { justify-content: flex-start; }
    .user-form-body { align-items: stretch; flex-direction: column; }
    .user-form-body .primary-button { align-self: flex-end; }
    .pagination { margin-left: 0; }
}
@media (max-width: 520px) {
    .limit-card { grid-template-columns: 1fr; }
    .limit-card > div { grid-column: auto; }
    .limit-card .tonal-button { justify-self: stretch; }
    .list-controls { align-items: stretch; }
    .pagination { width: 100%; justify-content: space-between; }
}
body.vscode-light { color-scheme: light; }
body.vscode-dark { color-scheme: dark; }
body.vscode-high-contrast { color-scheme: dark; }
`;
