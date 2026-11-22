import * as pulumi from '@pulumi/pulumi';
import { ProxmoxAccount, ProxmoxGroup } from '../components/proxmox/UserGroups';
import { ensureLocalSnippets } from './ensureSnippets';

export function getProxmoxVmIp(vm: proxmoxve.vm.VirtualMachine): pulumi.Output<string> {
  return vm.ipv4Addresses.apply((allIfaces) => {
    const ips = (allIfaces ?? []).flat().filter((candidate) => {
      return Boolean(candidate) && !candidate.startsWith('127.') && !candidate.startsWith('169.254.');
    });

    // Prefer LAN addresses over k3s/pod overlays (10.42/10.43).
    const preferred =
      ips.find((candidate) => candidate.startsWith('192.168.')) ??
      ips.find((candidate) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(candidate)) ??
      ips.find(
        (candidate) =>
          candidate.startsWith('10.') &&
          !candidate.startsWith('10.42.') &&
          !candidate.startsWith('10.43.'),
      ) ??
      ips[0];

    if (!preferred) {
      throw new Error(
        `No usable IPv4 address found on VM (guest reported: ${JSON.stringify(allIfaces)})`,
      );
    }

    return preferred;
  });
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
  password: process.env.PROXMOX_VIEWER_PASSWORD!,
  groupIds: [viewersGroup.groupId],
  provider,
});

export const adminUser = new ProxmoxAccount(`${$app.stage}-admin`, {
  userId: `admin-${$app.stage}@pve`,
  password: process.env.PROXMOX_ADMIN_PASSWORD!,
  groupIds: [adminsGroup.groupId],
  provider,
});

export const node = proxmoxve.getNodeOutput({ nodeName: 'pve' }, { provider: provider });

export const localSnippets = ensureLocalSnippets({
  nodeName: node.nodeName,
  endpoint: process.env.PROXMOX_VE_ENDPOINT!,
  username: process.env.PROXMOX_VE_USERNAME!,
  password: pulumi.secret(process.env.PROXMOX_VE_PASSWORD!),
  insecure: process.env.PROXMOX_VE_INSECURE === 'true',
});

export const ubuntuImage = new proxmoxve.download.File(
  `${$app.stage}-ubuntu-cloudimg`,
  {
    contentType: 'iso',
    datastoreId: 'local',
    nodeName: node.nodeName,
    fileName: `${$app.stage}-resolute-server-cloudimg-amd64.img`,
    url: 'https://cloud-images.ubuntu.com/resolute/current/resolute-server-cloudimg-amd64.img',
  },
  { provider: provider },
);
