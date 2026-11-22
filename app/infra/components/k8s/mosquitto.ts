import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface MosquittoStackArgs {
  provider: k8s.Provider;
  namespace?: string;
  image?: string;
  persistenceSize?: string;
  /** When true (default), LAN clients can publish/subscribe without auth. */
  allowAnonymous?: boolean;
  createServiceMonitor?: boolean;
  serviceMonitorDependsOn?: pulumi.Input<pulumi.Resource | pulumi.Resource[]>;
}

/** Eclipse Mosquitto broker. Prefer {@link EmqxStack} for this cluster. */
export class MosquittoStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly service: k8s.core.v1.Service;
  readonly serviceName: pulumi.Output<string>;

  constructor(name: string, args: MosquittoStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:MosquittoStack', name, {}, opts);

    const nsName = args.namespace ?? 'mqtt';
    const labels = { app: name };
    const allowAnonymous = args.allowAnonymous ?? true;
    // Pin 2.0.x — 2.1 Landlock + ConfigMap 0644 both break config loading in k8s.
    const image = args.image ?? 'eclipse-mosquitto:2.0.21';

    this.namespace = new k8s.core.v1.Namespace(
      nsName,
      { metadata: { name: nsName } },
      { provider: args.provider, parent: this },
    );

    const config = new k8s.core.v1.ConfigMap(
      `${name}-config`,
      {
        metadata: {
          name: `${name}-config`,
          namespace: nsName,
        },
        data: {
          'mosquitto.conf': `
listener 1883
protocol mqtt
allow_anonymous ${allowAnonymous}

listener 9001
protocol websockets
allow_anonymous ${allowAnonymous}

persistence true
persistence_location /mosquitto/data/
log_dest stdout
connection_messages true
`.trimStart(),
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.namespace },
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
              securityContext: {
                fsGroup: 1883,
              },
              initContainers: [
                {
                  name: 'copy-config',
                  image: 'busybox:1.36',
                  command: [
                    'sh',
                    '-c',
                    // Mosquitto rejects configs with "other" perms (ConfigMap default 0644).
                    'cp /config-src/mosquitto.conf /mosquitto/config/mosquitto.conf && chmod 0640 /mosquitto/config/mosquitto.conf && chown -R 1883:1883 /mosquitto/config',
                  ],
                  volumeMounts: [
                    { name: 'config-src', mountPath: '/config-src' },
                    { name: 'config', mountPath: '/mosquitto/config' },
                  ],
                  securityContext: { runAsUser: 0 },
                },
              ],
              containers: [
                {
                  name: 'mosquitto',
                  image,
                  ports: [
                    { name: 'mqtt', containerPort: 1883 },
                    { name: 'ws', containerPort: 9001 },
                  ],
                  volumeMounts: [
                    { name: 'config', mountPath: '/mosquitto/config' },
                    { name: 'data', mountPath: '/mosquitto/data' },
                  ],
                  resources: {
                    requests: { cpu: '25m', memory: '64Mi' },
                    limits: { cpu: '200m', memory: '128Mi' },
                  },
                  readinessProbe: {
                    tcpSocket: { port: 'mqtt' },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    tcpSocket: { port: 'mqtt' },
                    initialDelaySeconds: 15,
                    periodSeconds: 20,
                  },
                },
              ],
              volumes: [
                {
                  name: 'config-src',
                  configMap: { name: config.metadata.name },
                },
                { name: 'config', emptyDir: {} },
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
        dependsOn: [this.namespace, config, pvc],
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
            { name: 'ws', port: 9001, targetPort: 'ws' },
          ],
        },
      },
      { provider: args.provider, parent: this, dependsOn: broker },
    );

    this.serviceName = this.service.metadata.name;

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
