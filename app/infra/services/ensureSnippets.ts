import * as path from 'node:path';
import * as pulumi from '@pulumi/pulumi';

const scriptPath = path.join($cli.paths.root, 'app/infra/scripts/ensure-local-snippets.sh');

export function ensureLocalSnippets(args: {
  nodeName: pulumi.Input<string>;
  endpoint: string;
  username: string;
  password: pulumi.Input<string>;
  insecure: boolean;
}) {
  return new command.local.Command('local-snippets', {
    create: pulumi.interpolate`bash ${scriptPath}`,
    update: pulumi.interpolate`bash ${scriptPath}`,
    environment: {
      PROXMOX_VE_ENDPOINT: args.endpoint,
      PROXMOX_VE_USERNAME: args.username,
      PROXMOX_VE_PASSWORD: args.password,
      PROXMOX_VE_INSECURE: args.insecure ? 'true' : 'false',
      PROXMOX_NODE_NAME: args.nodeName,
    },
  });
}
