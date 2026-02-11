import { KubePrometheusStack } from '../components/k8s/KubePrometheusStack';
import { k3Master } from './proxmoxMaster';
import { workerVms } from './proxmoxWorkers';

const k8sProvider = new kubernetes.Provider('k3s');

export const kubePromStack = new KubePrometheusStack(
  'monitoring-stack',
  {
    provider: k8sProvider,
    namespace: 'monitoring',

    grafana: {
      enabled: true,
      ingress: {
        host: 'grafana.k3s.local',
        className: 'traefik',
      },
      pod: {
        resources: {
          requests: {
            cpu: '50m',
            memory: '128Mi',
          },
          limits: {
            cpu: '200m',
            memory: '256Mi',
          },
        },
      },
    },

    prometheus: {
      retention: '5d',
      scrapeInterval: '120s',
      pod: {
        resources: {
          requests: {
            cpu: '200m',
            memory: '512Mi',
          },
          limits: {
            cpu: '500m',
            memory: '1Gi',
          },
        },
      },
    },

    alertmanager: {
      enabled: true,
      pod: {
        resources: {
          requests: {
            cpu: '25m',
            memory: '64Mi',
          },
          limits: {
            cpu: '100m',
            memory: '128Mi',
          },
        },
      },
    },

    extraValues: {
      kubeStateMetrics: {
        resources: {
          requests: {
            cpu: '50m',
            memory: '128Mi',
          },
          limits: {
            cpu: '150m',
            memory: '256Mi',
          },
        },
      },

      prometheusOperator: {
        resources: {
          requests: {
            cpu: '50m',
            memory: '128Mi',
          },
          limits: {
            cpu: '200m',
            memory: '256Mi',
          },
        },
      },

      nodeExporter: {
        resources: {
          requests: {
            cpu: '10m',
            memory: '32Mi',
          },
          limits: {
            cpu: '50m',
            memory: '64Mi',
          },
        },
      },
    },
  },
  { dependsOn: [k3Master, workerVms[0].vm] },
);
