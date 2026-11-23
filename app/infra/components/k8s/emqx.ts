import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface EmqxDashboardIngressArgs {
  enabled?: boolean;
  host: string;
  className?: string;
  tlsSecretName?: string;
  annotations?: Record<string, string>;
}

export interface EmqxStackArgs {
  provider: k8s.Provider;
  namespace?: string;
  image?: string;
  persistenceSize?: string;
  dashboardUser?: string;
  dashboardPassword?: pulumi.Input<string>;
  /** When true (default), LAN clients can publish/subscribe without auth. */
  allowAnonymous?: boolean;
  /** Optional Traefik ingress for the dashboard (SSO / nicer URL). */
  dashboardIngress?: EmqxDashboardIngressArgs;
  /**
   * Create a ServiceMonitor for mqtt-exporter.
   * Pass false when Prometheus Operator CRDs are not installed yet.
   */
  createServiceMonitor?: boolean;
  serviceMonitorDependsOn?: pulumi.Input<pulumi.Resource | pulumi.Resource[]>;
}

export class EmqxStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly service: k8s.core.v1.Service;
  readonly serviceName: pulumi.Output<string>;

  constructor(name: string, args: EmqxStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:EmqxStack', name, {}, opts);

    const nsName = args.namespace ?? 'mqtt';
    const labels = { app: name };
    const allowAnonymous = args.allowAnonymous ?? true;
    const image = args.image ?? 'emqx/emqx:5.8.6';

    this.namespace = new k8s.core.v1.Namespace(
      nsName,
      { metadata: { name: nsName } },
      { provider: args.provider, parent: this },
    );

    const pvc = new k8s.core.v1.PersistentVolumeClaim(
      `${name}-data`,
      {
        metadata: {
          name: `${name}-data`,
          namespace: nsName,
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: {
            requests: {
              storage: args.persistenceSize ?? '1Gi',
            },
          },
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.namespace },
    );

    const env: k8s.types.input.core.v1.EnvVar[] = [
      { name: 'EMQX_NAME', value: name },
      { name: 'EMQX_CLUSTER__DISCOVERY_STRATEGY', value: 'singleton' },
      { name: 'EMQX_DASHBOARD__DEFAULT_USERNAME', value: args.dashboardUser ?? 'admin' },
      { name: 'EMQX_DASHBOARD__DEFAULT_PASSWORD', value: args.dashboardPassword ?? 'admin' },
      // Homelab single-node cookie (silences the default-cookie warning).
      { name: 'EMQX_NODE__COOKIE', value: 'homelab_emqx_cookie' },
      // Do not enable EMQX prometheus push (defaults to 127.0.0.1:9091).
      // MQTT metrics come from mqtt-exporter + ServiceMonitor instead.
    ];

    if (allowAnonymous) {
      env.push(
        { name: 'EMQX_AUTHENTICATION', value: '[]' },
        { name: 'EMQX_AUTHORIZATION__NO_MATCH', value: 'allow' },
      );
    }

    const broker = new k8s.apps.v1.Deployment(
      name,
      {
        metadata: {
          name,
          namespace: nsName,
          labels,
          annotations: {
            'pulumi.com/patchForce': 'true',
          },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          strategy: { type: 'Recreate' },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name: 'emqx',
                  image,
                  env,
                  ports: [
                    { name: 'mqtt', containerPort: 1883 },
                    { name: 'ws', containerPort: 8083 },
                    { name: 'dashboard', containerPort: 18083 },
                  ],
                  volumeMounts: [{ name: 'data', mountPath: '/opt/emqx/data' }],
                  resources: {
                    requests: { cpu: '100m', memory: '256Mi' },
                    limits: { cpu: '500m', memory: '512Mi' },
                  },
                  readinessProbe: {
                    tcpSocket: { port: 'mqtt' },
                    initialDelaySeconds: 10,
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    tcpSocket: { port: 'mqtt' },
                    initialDelaySeconds: 30,
                    periodSeconds: 20,
                  },
                },
              ],
              volumes: [
                {
                  name: 'data',
                  persistentVolumeClaim: { claimName: pvc.metadata.name },
                },
              ],
            },
          },
        },
      },
      {
        provider: args.provider,
        parent: this,
        dependsOn: [this.namespace, pvc],
      },
    );

    this.service = new k8s.core.v1.Service(
      name,
      {
        metadata: {
          name,
          namespace: nsName,
          labels,
        },
        spec: {
          type: 'LoadBalancer',
          selector: labels,
          ports: [
            { name: 'mqtt', port: 1883, targetPort: 'mqtt' },
            { name: 'ws', port: 8083, targetPort: 'ws' },
            { name: 'dashboard', port: 18083, targetPort: 'dashboard' },
          ],
        },
      },
      { provider: args.provider, parent: this, dependsOn: broker },
    );

    this.serviceName = this.service.metadata.name;

    if (args.dashboardIngress?.enabled !== false && args.dashboardIngress?.host) {
      new k8s.networking.v1.Ingress(
        `${name}-dashboard`,
        {
          metadata: {
            name: `${name}-dashboard`,
            namespace: nsName,
            labels,
            annotations: args.dashboardIngress.annotations,
          },
          spec: {
            ingressClassName: args.dashboardIngress.className ?? 'traefik',
            rules: [
              {
                host: args.dashboardIngress.host,
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: {
                        service: {
                          name,
                          port: { name: 'dashboard' },
                        },
                      },
                    },
                  ],
                },
              },
            ],
            tls: args.dashboardIngress.tlsSecretName
              ? [
                  {
                    secretName: args.dashboardIngress.tlsSecretName,
                    hosts: [args.dashboardIngress.host],
                  },
                ]
              : undefined,
          },
        },
        { provider: args.provider, parent: this, dependsOn: this.service },
      );
    }

    const exporterLabels = { app: `${name}-exporter` };
    const exporter = new k8s.apps.v1.Deployment(
      `${name}-exporter`,
      {
        metadata: {
          name: `${name}-exporter`,
          namespace: nsName,
          labels: exporterLabels,
          annotations: {
            'pulumi.com/patchForce': 'true',
          },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: exporterLabels },
          template: {
            metadata: { labels: exporterLabels },
            spec: {
              containers: [
                {
                  name: 'mqtt-exporter',
                  image: 'kpetrem/mqtt-exporter:1.12.1',
                  env: [
                    {
                      name: 'MQTT_ADDRESS',
                      value: pulumi.interpolate`${this.serviceName}.${nsName}.svc.cluster.local`,
                    },
                    { name: 'MQTT_PORT', value: '1883' },
                    { name: 'MQTT_TOPIC', value: '#' },
                    { name: 'PROMETHEUS_PORT', value: '9000' },
                  ],
                  ports: [{ name: 'metrics', containerPort: 9000 }],
                  resources: {
                    requests: { cpu: '10m', memory: '32Mi' },
                    limits: { cpu: '100m', memory: '64Mi' },
                  },
                  readinessProbe: {
                    httpGet: { path: '/metrics', port: 'metrics' },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
                },
              ],
            },
          },
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.service },
    );

    const exporterService = new k8s.core.v1.Service(
      `${name}-exporter`,
      {
        metadata: {
          name: `${name}-exporter`,
          namespace: nsName,
          labels: exporterLabels,
        },
        spec: {
          selector: exporterLabels,
          ports: [{ name: 'metrics', port: 9000, targetPort: 'metrics' }],
        },
      },
      { provider: args.provider, parent: this, dependsOn: exporter },
    );

    if (args.createServiceMonitor !== false) {
      const smDependsOn = args.serviceMonitorDependsOn
        ? [exporterService, args.serviceMonitorDependsOn]
        : [exporterService];

      new k8s.apiextensions.CustomResource(
        `${name}-servicemonitor`,
        {
          apiVersion: 'monitoring.coreos.com/v1',
          kind: 'ServiceMonitor',
          metadata: {
            name: `${name}-exporter`,
            namespace: nsName,
            labels: {
              ...exporterLabels,
              release: 'monitoring-stack',
            },
          },
          spec: {
            selector: {
              matchLabels: exporterLabels,
            },
            namespaceSelector: {
              matchNames: [nsName],
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
        { provider: args.provider, parent: this, dependsOn: smDependsOn },
      );
    }

    this.registerOutputs({
      namespace: this.namespace.metadata.name,
      serviceName: this.serviceName,
    });
  }
}
