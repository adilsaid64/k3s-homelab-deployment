import { KubePrometheusStack } from '../components/k8s/KubePrometheusStack';
import { k3Master } from './proxmoxMaster';
import { workerVms } from './proxmoxWorkers';
import { Excalidraw } from '../components/k8s/Excalidraw';
import { MinioStack } from '../components/k8s/minio';
import { LokiDistributedStack } from '../components/k8s/loki';

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

export const excalidraw = new Excalidraw('excalidraw', {
  provider: k8sProvider,
  namespace: 'exclaidraw',
  ingress: {
    enabled: true,
    host: 'draw.k3s.local',
    className: 'traefik',
  },
  pod: {
    resources: {
      requests: {
        cpu: '50m',
        memory: '64Mi',
      },
      limits: {
        cpu: '200m',
        memory: '128Mi',
      },
    },
  },
});

export const minio = new MinioStack('minio', {
  provider: k8sProvider,
  namespace: 'minio',

  ingress: {
    host: 'minio.k3s.local',
    className: 'traefik',
  },
});

export const loki = new LokiDistributedStack(
  'loki',
  {
    provider: k8sProvider,
    namespace: 'loki',

    minioServiceName: 'minio',
    minioAccessKey: 'minio',
    minioSecretKey: 'minio123',

    retention: '72h',

    ingress: {
      host: 'loki.k3s.local',
      className: 'traefik',
    },
  },
  {
    dependsOn: minio,
  },
);
