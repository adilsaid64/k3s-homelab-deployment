import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface TempoIngressArgs {
  enabled?: boolean;
  host: string;
  className?: string;
  tlsSecretName?: string;
}

export interface PodPlacementArgs {
  nodeSelector?: Record<string, string>;
  tolerations?: k8s.types.input.core.v1.Toleration[];
  resources?: {
    requests?: { cpu?: pulumi.Input<string>; memory?: pulumi.Input<string> };
    limits?: { cpu?: pulumi.Input<string>; memory?: pulumi.Input<string> };
  };
}

export interface TempoStackArgs {
  provider: k8s.Provider;
  namespace: string;
  retention?: string;
  persistenceSize?: string;
  /** Prometheus remote_write URL for Tempo metrics-generator (service graphs). */
  metricsRemoteWriteUrl?: string;
  ingress?: TempoIngressArgs;
  pod?: PodPlacementArgs;
  extraValues?: pulumi.Inputs;
}

export class TempoStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly release: k8s.helm.v3.Release;

  constructor(name: string, args: TempoStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:TempoStack', name, {}, opts);

    this.namespace = new k8s.core.v1.Namespace(
      args.namespace,
      {
        metadata: { name: args.namespace },
      },
      {
        provider: args.provider,
        parent: this,
      },
    );

    const resources = args.pod?.resources ?? {
      requests: { cpu: '50m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    };

    // Stable Service created by kube-prometheus-stack for the Prometheus CR.
    const metricsRemoteWriteUrl =
      args.metricsRemoteWriteUrl ??
      'http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write';

    this.release = new k8s.helm.v3.Release(
      name,
      {
        name: 'tempo',
        chart: 'tempo',
        version: '1.23.3',
        namespace: this.namespace.metadata.name,
        repositoryOpts: {
          repo: 'https://grafana.github.io/helm-charts',
        },
        timeout: 600,
        values: {
          fullnameOverride: 'tempo',
          replicas: 1,
          tempo: {
            reportingEnabled: false,
            retention: args.retention ?? '48h',
            receivers: {
              otlp: {
                protocols: {
                  grpc: {
                    endpoint: '0.0.0.0:4317',
                  },
                  http: {
                    endpoint: '0.0.0.0:4318',
                  },
                },
              },
            },
            metricsGenerator: {
              enabled: true,
              remoteWriteUrl: metricsRemoteWriteUrl,
            },
          },
          persistence: {
            enabled: true,
            size: args.persistenceSize ?? '5Gi',
          },
          resources,
          nodeSelector: args.pod?.nodeSelector,
          tolerations: args.pod?.tolerations,
          serviceMonitor: {
            enabled: true,
            additionalLabels: {
              release: 'monitoring-stack',
            },
          },
          ...(args.extraValues ?? {}),
        },
      },
      {
        provider: args.provider,
        parent: this,
        dependsOn: this.namespace,
      },
    );

    if (args.ingress) {
      const ingress = args.ingress;
      new k8s.networking.v1.Ingress(
        `${name}-ingress`,
        {
          metadata: {
            name: 'tempo',
            namespace: args.namespace,
          },
          spec: {
            ingressClassName: ingress.className ?? 'traefik',
            rules: [
              {
                host: ingress.host,
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: {
                        service: {
                          name: 'tempo',
                          port: { number: 3200 },
                        },
                      },
                    },
                  ],
                },
              },
            ],
            tls: ingress.tlsSecretName
              ? [
                  {
                    secretName: ingress.tlsSecretName,
                    hosts: [ingress.host],
                  },
                ]
              : undefined,
          },
        },
        {
          provider: args.provider,
          parent: this,
          dependsOn: [this.namespace, this.release],
        },
      );
    }

    // Expose OTLP so apps / agents on the LAN can push traces.
    new k8s.core.v1.Service(
      `${name}-otlp`,
      {
        metadata: {
          name: 'tempo-otlp',
          namespace: args.namespace,
          labels: { app: 'tempo' },
        },
        spec: {
          type: 'LoadBalancer',
          selector: {
            'app.kubernetes.io/name': 'tempo',
            'app.kubernetes.io/instance': 'tempo',
          },
          ports: [
            { name: 'otlp-grpc', port: 4317, targetPort: 4317 },
            { name: 'otlp-http', port: 4318, targetPort: 4318 },
          ],
        },
      },
      {
        provider: args.provider,
        parent: this,
        dependsOn: [this.namespace, this.release],
      },
    );

    this.registerOutputs({
      namespace: this.namespace.metadata.name,
      release: this.release.name,
    });
  }
}
