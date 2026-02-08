import { ProxmoxAccount, ProxmoxGroup } from '../../components/proxmox/UserGroups';
import * as pulumi from '@pulumi/pulumi';

function getProxmoxVmIp(vm: proxmoxve.vm.VirtualMachine) {
  const ip = vm.ipv4Addresses.apply((allIfaces) =>
    allIfaces.flat().find((ip) => !ip.startsWith('127.') && !ip.startsWith('10.')),
  );
  return ip;
}

const provider = new proxmoxve.Provider('proxmox', {
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

export const k3sToken = new random.RandomPassword(`${$app.stage}-k3s-token`, {
  length: 32,
  special: false,
});

export const masterCloudInit = new proxmoxve.storage.File(
  `${$app.stage}-k3s-master`,
  {
    contentType: 'snippets',
    datastoreId: 'local',
    nodeName: node.nodeName,
    sourceRaw: {
      fileName: `${$app.stage}-k3s-master.yml`,
      data: pulumi.interpolate`
#cloud-config
hostname: k3s-master-${$app.stage}
manage_etc_hosts: true

users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    passwd: ${process.env.VM_SSH_PASSWORD_HASH}
    ssh_authorized_keys:
      - ${process.env.SSH_PUBLIC_KEY}
ssh_pwauth: true
disable_root: true

package_update: true
packages:
  - curl
  - qemu-guest-agent

runcmd:
  - sudo systemctl enable qemu-guest-agent
  - sudo systemctl start qemu-guest-agent
  - |
    IP=$(hostname -I | awk '{print $1}')
    curl -sfL https://get.k3s.io | sudo sh -s - server \
      --write-kubeconfig-mode 644 \
      --token ${k3sToken.result} \
      --node-taint CriticalAddonsOnly=true:NoExecute \
      --node-ip $IP \
      --advertise-address $IP
  `,
    },
  },
  { provider },
);

export const masterVm = new proxmoxve.vm.VirtualMachine(
  `k3s-master-${$app.stage}`,
  {
    nodeName: node.nodeName,
    poolId: stagePool.poolId,
    cpu: { cores: 2, type: 'host' },
    memory: { dedicated: 4096 },
    scsiHardware: 'virtio-scsi-pci',
    disks: [
      {
        interface: 'scsi0',
        datastoreId: 'local-lvm',
        fileId: ubuntuImage.id,
        size: 8,
        ssd: true,
      },
    ],
    initialization: {
      datastoreId: 'local-lvm',
      ipConfigs: [{ ipv4: { address: 'dhcp' } }],
      userDataFileId: masterCloudInit.id,
    },
    cdrom: {
      fileId: 'none',
    },
    networkDevices: [
      {
        bridge: 'vmbr0',
        model: 'virtio',
      },
    ],
    operatingSystem: { type: 'l26' },
    agent: {
      enabled: true,
      timeout: '5m',
      waitForIp: {
        ipv4: true,
        ipv6: true,
      },
    },
    serialDevices: [
      {
        device: 'socket',
      },
    ],
    started: true,
    tags: [`k3s-${$app.stage}`],
  },
  { provider },
);

export const k3MasterIp = getProxmoxVmIp(masterVm);

export const workerCloudInit = new proxmoxve.storage.File(
  `${$app.stage}-k3s-worker`,
  {
    contentType: 'snippets',
    datastoreId: 'local',
    nodeName: node.nodeName,
    sourceRaw: {
      fileName: `${$app.stage}-k3s-worker.yml`,
      data: pulumi.interpolate`
#cloud-config
hostname: k3s-worker-${$app.stage}
manage_etc_hosts: true

users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    passwd: ${process.env.VM_SSH_PASSWORD_HASH}
    ssh_authorized_keys:
      - ${process.env.SSH_PUBLIC_KEY}
ssh_pwauth: true
disable_root: true

package_update: true
packages:
  - curl
  - qemu-guest-agent

runcmd:
  - sudo systemctl enable --now qemu-guest-agent
  - |
    set -eux
    export K3S_URL=https://${k3MasterIp}:6443
    export K3S_TOKEN=${k3sToken.result}
    curl -sfL https://get.k3s.io | K3S_URL="https://${k3MasterIp}:6443" K3S_TOKEN="${k3sToken.result}" sh -s - agent
  `,
    },
  },
  { provider },
);

export const workerVm = new proxmoxve.vm.VirtualMachine(
  `k3s-worker-${$app.stage}`,
  {
    nodeName: node.nodeName,
    poolId: stagePool.poolId,
    cpu: { cores: 2, type: 'host' },
    memory: { dedicated: 4096 },
    scsiHardware: 'virtio-scsi-pci',
    disks: [
      {
        interface: 'scsi0',
        datastoreId: 'local-lvm',
        fileId: ubuntuImage.id,
        size: 8,
        ssd: true,
      },
    ],
    initialization: {
      datastoreId: 'local-lvm',
      ipConfigs: [{ ipv4: { address: 'dhcp' } }],
      userDataFileId: workerCloudInit.id,
    },
    cdrom: {
      fileId: 'none',
    },
    networkDevices: [
      {
        bridge: 'vmbr0',
        model: 'virtio',
      },
    ],
    operatingSystem: { type: 'l26' },
    agent: {
      enabled: true,
      timeout: '5m',
      waitForIp: {
        ipv4: true,
        ipv6: true,
      },
    },
    serialDevices: [
      {
        device: 'socket',
      },
    ],
    started: true,
    tags: [`k3s-${$app.stage}`],
  },
  { provider },
);

export const workerVmIp = getProxmoxVmIp(workerVm);

// Api Goal, using cloud inits to automate all configs
// new K3sCluster('k3-master') // provisions control plane cluster
// new K3sNodeGroup('k3-worker-cpu', {...}) //
// new K3sNodeGroup('k3-worker-gpu', {...}) //
