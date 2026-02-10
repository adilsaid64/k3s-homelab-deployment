import * as pulumi from '@pulumi/pulumi';
import { getProxmoxVmIp } from '../../services';

interface ProxmoxMasterArgs {
    proxmoxNode: pulumi.Output<proxmoxve.GetNodeResult>;
    k3sToken: random.RandomPassword;
    ubuntuImageId: pulumi.Input<string>;
    poolId: pulumi.Input<string>;
    cloudInit: proxmoxve.storage.File
    ram: pulumi.Input<number>
    cores: pulumi.Input<number>
    diskMemory: pulumi.Input<number>
}

export class ProxmoxK3sMaster extends pulumi.ComponentResource {
    readonly vm: proxmoxve.vm.VirtualMachine;
    readonly ip: pulumi.Output<string>;

    constructor(name: string, args: ProxmoxMasterArgs, opts?: pulumi.ComponentResourceOptions) {
        super('custom:infra:ProxmoxMaster', name, {}, opts);

        this.vm = new proxmoxve.vm.VirtualMachine(
            `${name}-vm`,
            {
                nodeName: args.proxmoxNode.nodeName,
                poolId: args.poolId,
                cpu: { cores: args.cores, type: 'host' },
                memory: { dedicated: args.ram },
                scsiHardware: 'virtio-scsi-pci',
                disks: [
                    {
                        interface: 'scsi0',
                        datastoreId: 'local-lvm',
                        fileId: args.ubuntuImageId,
                        size: args.diskMemory,
                        ssd: true,
                    },
                ],
                initialization: {
                    datastoreId: 'local-lvm',
                    ipConfigs: [{ ipv4: { address: 'dhcp' } }],
                    userDataFileId: args.cloudInit.id,
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

        this.ip = getProxmoxVmIp(this.vm);

        this.registerOutputs({
            vm: this.vm,
            ip: this.ip,
        });
    }
}
