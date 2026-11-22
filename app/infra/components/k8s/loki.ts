import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface LokiIngressArgs {
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

export interface LokiStackArgs {
  provider: k8s.Provider;
  namespace: string;
  retention?: string;
  persistenceSize?: string;
  ingress?: LokiIngressArgs;
  pod?: PodPlacementArgs;
  extraValues?: pulumi.Inputs;
}

export class LokiStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly release: k8s.helm.v3.Release;

  constructor(name: string, args: LokiStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:LokiStack', name, {}, opts);

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

    const ingress = args.ingress;
    const resources = args.pod?.resources ?? {
      requests: { cpu: '50m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    };

    this.release = new k8s.helm.v3.Release(
      name,
      {
        name: 'loki',
        chart: 'loki',
        version: '6.16.0',
        namespace: this.namespace.metadata.name,
        repositoryOpts: {
          repo: 'https://grafana.github.io/helm-charts',
        },
        timeout: 600,
        values: {
          fullnameOverride: 'loki',
          deploymentMode: 'SingleBinary',
          loki: {
            auth_enabled: false,
            commonConfig: {
              replication_factor: 1,
            },
            storage: {
              type: 'filesystem',
            },
            schemaConfig: {
              configs: [
                {
                  from: '2024-04-01',
                  store: 'tsdb',
                  object_store: 'filesystem',
                  schema: 'v13',
                  index: {
                    prefix: 'loki_index_',
                    period: '24h',
                  },
                },
              ],
            },
            limits_config: {
              retention_period: args.retention ?? '72h',
              allow_structured_metadata: true,
            },
          },
          singleBinary: {
            replicas: 1,
            persistence: {
              enabled: true,
              size: args.persistenceSize ?? '10Gi',
            },
            resources,
            nodeSelector: args.pod?.nodeSelector,
            tolerations: args.pod?.tolerations,
          },
          backend: { replicas: 0 },
          read: { replicas: 0 },
          write: { replicas: 0 },
          ingester: { replicas: 0 },
          distributor: { replicas: 0 },
          querier: { replicas: 0 },
          queryFrontend: { replicas: 0 },
          queryScheduler: { replicas: 0 },
          compactor: { replicas: 0 },
          indexGateway: { replicas: 0 },
          bloomPlanner: { replicas: 0 },
          bloomBuilder: { replicas: 0 },
          bloomGateway: { replicas: 0 },
          // Default memcached caches request ~10Gi and will not schedule here.
          chunksCache: { enabled: false },
          resultsCache: { enabled: false },
          minio: { enabled: false },
          lokiCanary: { enabled: false },
          test: { enabled: false },
          gateway: {
            enabled: true,
            resources,
            ingress: ingress
              ? {
                  enabled: ingress.enabled ?? true,
                  ingressClassName: ingress.className ?? 'traefik',
                  hosts: [
                    {
                      host: ingress.host,
                      paths: [{ path: '/', pathType: 'Prefix' }],
                    },
                  ],
                  tls: ingress.tlsSecretName
                    ? [
                        {
                          secretName: ingress.tlsSecretName,
                          hosts: [ingress.host],
                        },
                      ]
                    : [],
                }
              : { enabled: false },
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

    this.registerOutputs({
      namespace: this.namespace.metadata.name,
      release: this.release.name,
    });
  }
}
