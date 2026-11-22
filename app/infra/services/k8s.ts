import * as pulumi from '@pulumi/pulumi';
import { KubePrometheusStack } from '../components/k8s/KubePrometheusStack';
import { Excalidraw } from '../components/k8s/Excalidraw';
import { MinioStack } from '../components/k8s/minio';
import { LokiStack } from '../components/k8s/loki';
import { clusterReady, k8sProvider } from './kubeconfig';

const k8sDependsOn = [clusterReady];

if (!process.env.GRAFANA_ADMIN_PASSWORD) {
  throw new Error('GRAFANA_ADMIN_PASSWORD must be set in .env');
}

export const kubePromStack = new KubePrometheusStack(
  'monitoring-stack',
  {
    provider: k8sProvider,
    namespace: 'monitoring',

    grafana: {
      enabled: true,
      adminUser: process.env.GRAFANA_ADMIN_USER ?? 'admin',
      adminPassword: pulumi.secret(process.env.GRAFANA_ADMIN_PASSWORD),
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
  { dependsOn: k8sDependsOn },
);

export const excalidraw = new Excalidraw(
  'excalidraw',
  {
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
  },
  { dependsOn: k8sDependsOn },
);

export const minio = new MinioStack(
  'minio',
  {
    provider: k8sProvider,
    namespace: 'minio',
    ingress: {
      host: 'minio.k3s.local',
      className: 'traefik',
    },
  },
  { dependsOn: k8sDependsOn },
);

export const loki = new LokiStack(
  'loki',
  {
    provider: k8sProvider,
    namespace: 'loki',
    retention: '72h',
    ingress: {
      host: 'loki.k3s.local',
      className: 'traefik',
    },
  },
  { dependsOn: k8sDependsOn },
);
