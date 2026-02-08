/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: "k3s-homelab-deployment",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "local",
      providers: {
        "@muhlba91/pulumi-proxmoxve": "7.12.0",
      },
    };
  },
  async run() {
    const serviceInfra = await import('./app/infra/services');
  },
});
