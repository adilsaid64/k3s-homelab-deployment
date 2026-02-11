import * as pulumi from '@pulumi/pulumi';

import { ProxmoxK3sWorker } from '../components/proxmox/K3sWorker';
import { node, stagePool, ubuntuImage, provider } from './proxmox';
import { k3Master, k3MasterIp, k3sToken } from './proxmoxMaster';

const workerCount = 3;

export const workerVms = Array.from({ length: workerCount }, (_, i) => {
  const workerCloudInit = new proxmoxve.storage.File(
    `${$app.stage}-k3s-worker-${i}`,
    {
      contentType: 'snippets',
      datastoreId: 'local',
      nodeName: node.nodeName,
      sourceRaw: {
        fileName: `${$app.stage}-k3s-worker-${i}.yml`,
        data: pulumi.interpolate`
#cloud-config
hostname: k3s-worker-${$app.stage}-${i}
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

  const vm = new ProxmoxK3sWorker(
    `k3s-worker-${$app.stage}-${i}`,
    {
      cloudInit: workerCloudInit,
      k3sToken: k3sToken,
      poolId: stagePool.poolId,
      ubuntuImageId: ubuntuImage.id,
      proxmoxNode: node,
      ram: 8192,
      cores: 2,
      diskMemory: 20,
    },
    { provider: provider, dependsOn: [k3Master] },
  );
  return { workerCloudInit, vm };
});

export const workerVmIps = workerVms.map((vm) => vm.vm.ip);
