import { KubePrometheusStack } from '../components/k8s/KubePrometheusStack';
import { k3Master } from './proxmoxMaster';
import { workerVms } from './proxmoxWorkers';

const k8sProvider = new kubernetes.Provider('k3s');

export const kubePromStack = new KubePrometheusStack('monitoring', {
  provider: k8sProvider,
  namespace: 'monitoring',
  grafana: {
    ingress: {
      host: 'grafana.k3s.local',
      className: 'traefik',
    },
  },
  prometheus: {
    retention: '5d',
    scrapeInterval: '120s',
  },
}, { dependsOn: [k3Master, workerVms[0]] });
