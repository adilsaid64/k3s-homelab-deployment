import { ProxmoxAccount, ProxmoxGroup } from "../components/ProxmoxUserGroups";

const provider = new proxmoxve.Provider("proxmox", {
    endpoint: process.env.PROXMOX_VE_ENDPOINT!,
    insecure: process.env.PROXMOX_VE_INSECURE === "true",
    username: process.env.PROXMOX_VE_USERNAME!,
    password: process.env.PROXMOX_VE_PASSWORD!,
});

export const stagePool = new proxmoxve.permission.Pool(`${$app.stage}-pood`, {
    poolId: `${$app.stage}-pool`,
    comment: `Pool for deployment stage ${$app.stage}`
});

export const adminsGroup = new ProxmoxGroup(`${$app.stage}-admins`, {
    groupId: `admins-${$app.stage}`,
    role: "PVEAdmin",
    scope: "pool",
    poolId: stagePool.id,
    provider,
});

export const viewersGroup = new ProxmoxGroup(`${$app.stage}-viewers`, {
    groupId: `viewers-${$app.stage}`,
    role: "PVEAuditor",
    scope: "pool",
    poolId: stagePool.id,
    provider,
});

export const viewerUser = new ProxmoxAccount(`${$app.stage}-viewer`, {
    userId: `viewer-${$app.stage}@pve`,
    password: "password",
    groupId: viewersGroup.groupId,
    provider,
});

export const adminUser = new ProxmoxAccount(`${$app.stage}-admin`, {
    userId: `admin-${$app.stage}@pve`,
    password: 'password',
    groupId: adminsGroup.groupId,
    provider,
});

export const node = proxmoxve.getNodeOutput({ nodeName: 'proxmox' }, { provider: provider });

export const ubuntuImage = new proxmoxve.download.File("ubuntu-cloudimg", {
    contentType: "iso",
    datastoreId: "local",
    nodeName: node.nodeName,
    url: "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img",
}, { provider: provider });


