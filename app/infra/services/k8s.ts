import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { KubePrometheusStack } from '../components/k8s/KubePrometheusStack';
import { Excalidraw } from '../components/k8s/Excalidraw';
import { MinioStack } from '../components/k8s/minio';
import { LokiStack } from '../components/k8s/loki';
import { AlloyStack } from '../components/k8s/alloy';
import { TempoStack } from '../components/k8s/tempo';
import { EmqxStack } from '../components/k8s/emqx';
import { AuthentikStack } from '../components/k8s/authentik';
import { HomelabSso } from '../components/authentik/homelabSso';
import { PostgresStack } from '../components/k8s/postgres';
import { clusterReady, k8sProvider } from './kubeconfig';

/** Traefik middleware annotation: local Middleware named `authentik` in that namespace. */
const forwardAuthAnnotation = (namespace: string): Record<string, string> => ({
  'traefik.ingress.kubernetes.io/router.middlewares': `${namespace}-authentik@kubernetescrd`,
});

const k8sDependsOn = [clusterReady];

if (!process.env.GRAFANA_ADMIN_PASSWORD) {
  throw new Error('GRAFANA_ADMIN_PASSWORD must be set in .env');
}
if (!process.env.AUTHENTIK_SECRET_KEY || process.env.AUTHENTIK_SECRET_KEY.length < 50) {
  throw new Error('AUTHENTIK_SECRET_KEY must be set in .env (min 50 chars)');
}
if (!process.env.AUTHENTIK_BOOTSTRAP_TOKEN) {
  throw new Error('AUTHENTIK_BOOTSTRAP_TOKEN must be set in .env (openssl rand -hex 32)');
}
if (!process.env.AUTHENTIK_BOOTSTRAP_PASSWORD) {
  throw new Error('AUTHENTIK_BOOTSTRAP_PASSWORD must be set in .env');
}
const postgresPassword = process.env.POSTGRES_PASSWORD ?? process.env.AUTHENTIK_POSTGRES_PASSWORD;
if (!postgresPassword) {
  throw new Error('POSTGRES_PASSWORD must be set in .env');
}

export const postgres = new PostgresStack(
  'postgres',
  {
    provider: k8sProvider,
    namespace: 'postgres',
    database: 'authentik',
    username: 'authentik',
    password: pulumi.secret(postgresPassword),
  },
  { dependsOn: k8sDependsOn },
);

export const authentik = new AuthentikStack(
  'authentik',
  {
    provider: k8sProvider,
    namespace: 'authentik',
    secretKey: pulumi.secret(process.env.AUTHENTIK_SECRET_KEY),
    bootstrap: {
      token: pulumi.secret(process.env.AUTHENTIK_BOOTSTRAP_TOKEN),
      password: pulumi.secret(process.env.AUTHENTIK_BOOTSTRAP_PASSWORD),
      email: process.env.AUTHENTIK_BOOTSTRAP_EMAIL ?? 'admin@k3s.local',
    },
    postgres: {
      host: postgres.host,
      database: postgres.database,
      username: postgres.username,
      password: postgres.password,
    },
    ingress: {
      host: 'auth.k3s.local',
      className: 'traefik',
    },
  },
  { dependsOn: [...k8sDependsOn, postgres] },
);

const authentikPublicUrl = process.env.AUTHENTIK_URL ?? 'http://auth.k3s.local';

export const emqx = new EmqxStack(
  'emqx',
  {
    provider: k8sProvider,
    namespace: 'mqtt',
    allowAnonymous: true,
    dashboardIngress: {
      host: 'emqx.k3s.local',
      className: 'traefik',
      annotations: forwardAuthAnnotation('mqtt'),
    },
    // ServiceMonitor needs Prometheus Operator CRDs from kube-prometheus-stack.
    createServiceMonitor: false,
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
      annotations: forwardAuthAnnotation('loki'),
    },
  },
  { dependsOn: k8sDependsOn },
);

export const alloy = new AlloyStack(
  'alloy',
  {
    provider: k8sProvider,
    namespace: 'alloy',
    lokiPushUrl: 'http://loki-gateway.loki.svc.cluster.local/loki/api/v1/push',
  },
  { dependsOn: [...k8sDependsOn, loki] },
);

export const tempo = new TempoStack(
  'tempo',
  {
    provider: k8sProvider,
    namespace: 'tempo',
    retention: '48h',
    ingress: {
      host: 'tempo.k3s.local',
      className: 'traefik',
      annotations: forwardAuthAnnotation('tempo'),
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
      annotations: forwardAuthAnnotation('exclaidraw'),
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

/** OIDC (Grafana/MinIO) + domain forward-auth (draw/tempo/loki/emqx). */
export const homelabSso = new HomelabSso(
  'homelab-sso',
  {
    provider: k8sProvider,
    authentikUrl: authentikPublicUrl,
    authentikToken: pulumi.secret(process.env.AUTHENTIK_BOOTSTRAP_TOKEN!),
    forwardAuthNamespaces: ['exclaidraw', 'tempo', 'loki', 'mqtt'],
  },
  { dependsOn: [authentik, excalidraw, tempo, loki, emqx] },
);

const mqttDashboard = JSON.stringify({
  annotations: { list: [] },
  editable: true,
  fiscalYearStartMonth: 0,
  graphTooltip: 0,
  id: null,
  links: [],
  panels: [
    {
      title: 'MQTT messages received',
      type: 'timeseries',
      gridPos: { h: 8, w: 12, x: 0, y: 0 },
      datasource: { type: 'prometheus', uid: 'prometheus' },
      targets: [
        {
          expr: 'sum(rate(mqtt_message_total[1m]))',
          legendFormat: 'msg/s',
          refId: 'A',
        },
      ],
    },
    {
      title: 'MQTT messages by topic',
      type: 'timeseries',
      gridPos: { h: 8, w: 12, x: 12, y: 0 },
      datasource: { type: 'prometheus', uid: 'prometheus' },
      targets: [
        {
          expr: 'sum by (topic) (rate(mqtt_message_total[1m]))',
          legendFormat: '{{topic}}',
          refId: 'A',
        },
      ],
    },
    {
      title: 'Recent logs (Loki)',
      type: 'logs',
      gridPos: { h: 10, w: 24, x: 0, y: 8 },
      datasource: { type: 'loki', uid: 'loki' },
      targets: [
        {
          expr: '{namespace=~".+"}',
          refId: 'A',
        },
      ],
    },
  ],
  schemaVersion: 39,
  tags: ['mqtt', 'homelab'],
  templating: { list: [] },
  time: { from: 'now-15m', to: 'now' },
  timezone: 'browser',
  title: 'MQTT & Logs',
  uid: 'mqtt-logs',
  version: 1,
});

export const kubePromStack = new KubePrometheusStack(
  'monitoring-stack',
  {
    provider: k8sProvider,
    namespace: 'monitoring',

    grafana: {
      enabled: true,
      adminUser: process.env.GRAFANA_ADMIN_USER ?? 'admin',
      adminPassword: pulumi.secret(process.env.GRAFANA_ADMIN_PASSWORD),
      plugins: ['grafana-mqtt-datasource'],
      additionalDataSources: [
        {
          name: 'Loki',
          type: 'loki',
          access: 'proxy',
          url: 'http://loki-gateway.loki.svc.cluster.local',
          uid: 'loki',
          isDefault: false,
          jsonData: {
            maxLines: 1000,
            timeout: 60,
            derivedFields: [
              {
                datasourceUid: 'tempo',
                matcherRegex: 'traceID=(\\w+)|"trace_id":"(\\w+)"',
                name: 'TraceID',
                url: '${__value.raw}',
                urlDisplayLabel: 'View Trace',
              },
            ],
          },
        },
        {
          name: 'Tempo',
          type: 'tempo',
          access: 'proxy',
          url: 'http://tempo.tempo.svc.cluster.local:3200',
          uid: 'tempo',
          isDefault: false,
          jsonData: {
            tracesToLogsV2: {
              datasourceUid: 'loki',
              spanStartTimeShift: '-1h',
              spanEndTimeShift: '1h',
              filterByTraceID: true,
              filterBySpanID: false,
            },
            tracesToMetrics: {
              datasourceUid: 'prometheus',
            },
            serviceMap: {
              datasourceUid: 'prometheus',
            },
            nodeGraph: {
              enabled: true,
            },
            lokiSearch: {
              datasourceUid: 'loki',
            },
          },
        },
        {
          name: 'MQTT',
          type: 'grafana-mqtt-datasource',
          access: 'proxy',
          uid: 'mqtt',
          jsonData: {
            uri: 'tcp://emqx.mqtt.svc.cluster.local:1883',
          },
        },
      ],
      dashboards: {
        default: {
          'mqtt-logs': {
            json: mqttDashboard,
          },
        },
      },
      ingress: {
        host: 'grafana.k3s.local',
        className: 'traefik',
      },
      grafanaIni: homelabSso.grafanaIni,
      env: homelabSso.grafanaEnv,
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
  { dependsOn: [...k8sDependsOn, loki, tempo, emqx, homelabSso] },
);

// Scrape MQTT exporter once Prometheus Operator CRDs exist.
new k8s.apiextensions.CustomResource(
  'emqx-exporter-servicemonitor',
  {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'ServiceMonitor',
    metadata: {
      name: 'emqx-exporter',
      namespace: 'mqtt',
      labels: {
        app: 'emqx-exporter',
        release: 'monitoring-stack',
      },
    },
    spec: {
      selector: {
        matchLabels: { app: 'emqx-exporter' },
      },
      namespaceSelector: {
        matchNames: ['mqtt'],
      },
      endpoints: [
        {
          port: 'metrics',
          interval: '30s',
          path: '/metrics',
        },
      ],
    },
  },
  { provider: k8sProvider, dependsOn: [emqx, kubePromStack] },
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
    extraEnv: homelabSso.minioOidcEnv,
  },
  { dependsOn: [...k8sDependsOn, homelabSso] },
);
