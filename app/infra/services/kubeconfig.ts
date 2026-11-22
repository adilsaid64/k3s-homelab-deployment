import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as command from '@pulumi/command';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { k3Master, k3MasterIp } from './proxmoxMaster';
import { workerVms } from './proxmoxWorkers';

const privateKeyPath =
  process.env.SSH_PRIVATE_KEY_PATH ?? path.join(os.homedir(), '.ssh', 'id_ed25519');
const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

// Master is tainted, so wait for master + workers before installing workloads.
const expectedReadyNodes = 1 + workerVms.length;

const masterHost = k3MasterIp.apply((ip) => {
  if (!ip) {
    throw new Error('k3s master has no IPv4 address; cannot SSH for kubeconfig');
  }
  return ip;
});

export const clusterReady = new command.remote.Command(
  'k3s-cluster-ready',
  {
    connection: {
      host: masterHost,
      user: 'ubuntu',
      privateKey: pulumi.secret(privateKey),
    },
    create: `set -euo pipefail
for i in $(seq 1 90); do
  if [ -f /etc/rancher/k3s/k3s.yaml ] \\
    && sudo k3s kubectl get nodes --no-headers 2>/dev/null \\
      | awk '$2=="Ready"{c++} END{exit !(c>=${expectedReadyNodes})}'; then
    sudo cat /etc/rancher/k3s/k3s.yaml
    exit 0
  fi
  sleep 10
done
echo "timed out waiting for ${expectedReadyNodes} Ready k3s nodes" >&2
sudo k3s kubectl get nodes >&2 || true
exit 1
`,
  },
  {
    dependsOn: [k3Master, ...workerVms.map((worker) => worker.vm)],
  },
);

export const kubeconfig = pulumi
  .all([clusterReady.stdout, masterHost])
  .apply(([cfg, ip]) =>
    cfg
      .replace(/server:\s*https:\/\/127\.0\.0\.1:6443/g, `server: https://${ip}:6443`)
      .replace(/server:\s*https:\/\/localhost:6443/g, `server: https://${ip}:6443`),
  );

export const k8sProvider = new k8s.Provider(
  'k3s',
  {
    kubeconfig,
    enableServerSideApply: true,
  },
  { dependsOn: [clusterReady] },
);
