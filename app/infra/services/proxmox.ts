import { ProxmoxAccount, ProxmoxGroup } from "../components/ProxmoxUserGroups";

const provider = new proxmoxve.Provider("proxmox", {
    endpoint: process.env.PROXMOX_VE_ENDPOINT!,
    insecure: process.env.PROXMOX_VE_INSECURE === "true",
    username: process.env.PROXMOX_VE_USERNAME!,
    password: process.env.PROXMOX_VE_PASSWORD!,
});

export const adminsGroup = new ProxmoxGroup("admins", {
    groupId: `admins-${$app.stage}`,
    role: "PVEAdmin",
    scope: "datacenter", // TODO: Scope down later on
    provider,
});

export const adminUser = new ProxmoxAccount("admin", {
    userId: `admin-${$app.stage}@pve`,
    groupId: adminsGroup.groupId,
    provider,
});