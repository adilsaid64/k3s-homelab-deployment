import { ProxmoxK3sMaster } from '../components/proxmox/K3sMaster';
import { ProxmoxK3sWorker } from '../components/proxmox/K3sWorker';
import { ProxmoxAccount, ProxmoxGroup } from '../components/proxmox/UserGroups';
import * as pulumi from '@pulumi/pulumi';

export function getProxmoxVmIp(vm: proxmoxve.vm.VirtualMachine) {
  const ip = vm.ipv4Addresses.apply((allIfaces) =>
    allIfaces.flat().find((ip) => !ip.startsWith('127.') && !ip.startsWith('10.')),
  );
  return ip;
}
export const provider = new proxmoxve.Provider('proxmox', {
  endpoint: process.env.PROXMOX_VE_ENDPOINT!,
  insecure: process.env.PROXMOX_VE_INSECURE === 'true',
  username: process.env.PROXMOX_VE_USERNAME!,
  password: process.env.PROXMOX_VE_PASSWORD!,
});

export const stagePool = new proxmoxve.permission.Pool(`${$app.stage}-pool`, {
  poolId: `${$app.stage}-pool`,
  comment: `Pool for deployment stage ${$app.stage}`,
});

export const adminsGroup = new ProxmoxGroup(`${$app.stage}-admins`, {
  groupId: `admins-${$app.stage}`,
  role: 'PVEAdmin',
  scope: 'pool',
  poolId: stagePool.id,
  provider,
});

export const viewersGroup = new ProxmoxGroup(`${$app.stage}-viewers`, {
  groupId: `viewers-${$app.stage}`,
  role: 'PVEAuditor',
  scope: 'pool',
  poolId: stagePool.id,
  provider,
});

export const viewerUser = new ProxmoxAccount(`${$app.stage}-viewer`, {
  userId: `viewer-${$app.stage}@pve`,
  password: process.env.PROXMOX_VIEWER_PASSWORD,
  groupIds: [viewersGroup.groupId],
  provider,
});

export const adminUser = new ProxmoxAccount(`${$app.stage}-admin`, {
  userId: `admin-${$app.stage}@pve`,
  password: process.env.PROXMOX_ADMIN_PASSWORD,
  groupIds: [adminsGroup.groupId],
  provider,
});

export const node = proxmoxve.getNodeOutput({ nodeName: 'proxmox' }, { provider: provider });

export const ubuntuImage = new proxmoxve.download.File(
  `${$app.stage}-ubuntu-cloudimg`,
  {
    contentType: 'iso',
    datastoreId: 'local',
    nodeName: node.nodeName,
    fileName: `${$app.stage}-jammy-server-cloudimg-amd64.img`,
    url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
  },
  { provider: provider },
);
