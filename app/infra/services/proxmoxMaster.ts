import * as pulumi from '@pulumi/pulumi';

import { node, stagePool, ubuntuImage, provider } from './proxmox';
import { ProxmoxK3sMaster } from '../components/proxmox/K3sMaster';

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

export const k3Master = new ProxmoxK3sMaster(
  `k3s-master-${$app.stage}`,
  {
    k3sToken: k3sToken,
    poolId: stagePool.poolId,
    proxmoxNode: node,
    ubuntuImageId: ubuntuImage.id,
    cloudInit: masterCloudInit,
    ram: 4096,
    cores: 2,
    diskMemory: 12,
  },
  { provider: provider },
);

export const k3MasterIp = k3Master.ip;
