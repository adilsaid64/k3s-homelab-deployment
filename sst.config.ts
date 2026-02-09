/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: 'k3s-homelab-deployment',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'local',
      providers: {
        '@muhlba91/pulumi-proxmoxve': '7.12.0',
        '@pulumi/random': '4.19.1',
        '@pulumi/kubernetes': '4.25.0',
      },
    };
  },
  async run() {
    const serviceInfra = await import('./app/infra/services');
    return {
      // proxmoxNodeName: serviceInfra.node.nodeName,
      // proxmoxNodeCpuCount: serviceInfra.node.cpuCount,
      // proxmoxNodeMemoryAvailable: serviceInfra.node.memoryAvailable,
      // proxmoxNodeMemoryUsed: serviceInfra.node.memoryUsed,
      // proxmoxNodeCpuModel: serviceInfra.node.cpuModel,
      // proxmoxUser: serviceInfra.adminUser.userId,
      // proxmoxToken: serviceInfra.adminUser.tokenId,
      // stagePoolsId: serviceInfra.stagePool.poolId,
      // poolsId: serviceInfra.stagePool.id,
      // ubuntoImage: serviceInfra.ubuntuImage.id,
      k3MasterIp: serviceInfra.k3MasterIp,
      // workerVmIp: serviceInfra.workerVmIp,
    };
  },
});
