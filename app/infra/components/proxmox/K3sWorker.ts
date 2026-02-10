import * as pulumi from '@pulumi/pulumi';
import { getProxmoxVmIp } from '../../services';


interface ProxmoxMasterArgs {
    proxmoxNode: pulumi.Output<proxmoxve.GetNodeResult>
    k3sToken: random.RandomPassword
    ubuntuImageId: pulumi.Input<string>
    poolId: pulumi.Input<string>
}

export class ProxmoxK3sMaster extends pulumi.ComponentResource {
    readonly masterVm: proxmoxve.vm.VirtualMachine
    readonly masterIp: pulumi.Output<string>

    constructor(name: string, args: ProxmoxMasterArgs, opts?: pulumi.ComponentResourceOptions) {
        super('custom:infra:ProxmoxMaster', name, {}, opts);

        const cloudInit = new proxmoxve.storage.File(
            `${$app.stage}-k3s-master`,
            {
                contentType: 'snippets',
                datastoreId: 'local',
                nodeName: args.proxmoxNode.nodeName,
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
        --token ${args.k3sToken.result} \
        --node-taint CriticalAddonsOnly=true:NoExecute \
        --node-ip $IP \
        --advertise-address $IP
  `,
                },
            },
            { provider: opts.provider },
        );

        this.masterVm = new proxmoxve.vm.VirtualMachine(
            `k3s-master-${$app.stage}`,
            {
                nodeName: args.proxmoxNode.nodeName,
                poolId: args.poolId,
                cpu: { cores: 2, type: 'host' },
                memory: { dedicated: 4096 },
                scsiHardware: 'virtio-scsi-pci',
                disks: [
                    {
                        interface: 'scsi0',
                        datastoreId: 'local-lvm',
                        fileId: args.ubuntuImageId,
                        size: 8,
                        ssd: true,
                    },
                ],
                initialization: {
                    datastoreId: 'local-lvm',
                    ipConfigs: [{ ipv4: { address: 'dhcp' } }],
                    userDataFileId: cloudInit.id,
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
            { provider: opts.provider },
        );

        this.masterIp = getProxmoxVmIp(this.masterVm)

        this.registerOutputs({
            masterVm: this.masterVm,
            // 
        });
    }
}
