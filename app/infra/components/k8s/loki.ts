import * as pulumi from '@pulumi/pulumi';

export interface LokiIngressArgs {
  enabled?: boolean;
  host: string;
  className?: string;
  tlsSecretName?: string;
}

export interface PodPlacementArgs {
  nodeSelector?: Record<string, string>;
  tolerations?: kubernetes.types.input.core.v1.Toleration[];
  resources?: {
    requests?: { cpu?: pulumi.Input<string>; memory?: pulumi.Input<string> };
    limits?: { cpu?: pulumi.Input<string>; memory?: pulumi.Input<string> };
  };
}

export interface LokiDistributedArgs {
  provider: kubernetes.Provider;
  namespace: string;

  minioServiceName?: string;
  minioAccessKey?: pulumi.Input<string>;
  minioSecretKey?: pulumi.Input<string>;

  retention?: string;

  ingress?: LokiIngressArgs;

  extraValues?: pulumi.Inputs;
}

export class LokiDistributedStack extends pulumi.ComponentResource {
  readonly namespace: kubernetes.core.v1.Namespace;
  readonly release: kubernetes.helm.v3.Release;

  constructor(name: string, args: LokiDistributedArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:LokiDistributedStack', name, {}, opts);

    this.namespace = new kubernetes.core.v1.Namespace(
      args.namespace,
      {
        metadata: { name: args.namespace },
      },
      {
        provider: args.provider,
        parent: this,
      },
    );

    const minioHost = pulumi.interpolate`${args.minioServiceName ?? 'minio'}.${args.namespace}.svc.cluster.local:9000`;

    const tinyResources = {
      requests: {
        cpu: '50m',
        memory: '128Mi',
      },
      limits: {
        cpu: '300m',
        memory: '256Mi',
      },
    };

    const ingress = args.ingress;

    this.release = new kubernetes.helm.v3.Release(
      name,
      {
        chart: 'loki',
        version: '6.16.0',
        namespace: this.namespace.metadata.name,
        repositoryOpts: {
          repo: 'https://grafana.github.io/helm-charts',
        },
        values: {
          deploymentMode: 'Distributed',

          loki: {
            auth_enabled: false,

            schemaConfig: {
              configs: [
                {
                  from: '2024-04-01',
                  store: 'tsdb',
                  object_store: 's3',
                  schema: 'v13',
                  index: {
                    prefix: 'loki_index_',
                    period: '24h',
                  },
                },
              ],
            },

            storage_config: {
              aws: {
                s3: pulumi.interpolate`s3://${args.minioAccessKey ?? 'minio'}:${args.minioSecretKey ?? 'minio123'}@${minioHost}`,
                s3forcepathstyle: true,
                insecure: true,
              },
            },

            limits_config: {
              retention_period: args.retention ?? '72h',
              ingestion_rate_mb: 4,
              ingestion_burst_size_mb: 6,
              allow_structured_metadata: true,
            },

            querier: {
              max_concurrent: 2,
            },
          },

          ingester: {
            replicas: 1,
            resources: tinyResources,
          },

          distributor: {
            replicas: 1,
            resources: tinyResources,
          },

          querier: {
            replicas: 1,
            resources: tinyResources,
          },

          queryFrontend: {
            replicas: 1,
            resources: tinyResources,
          },

          queryScheduler: {
            replicas: 1,
            resources: tinyResources,
          },

          compactor: {
            replicas: 1,
            resources: tinyResources,
          },

          indexGateway: {
            replicas: 1,
            resources: tinyResources,
          },

          bloomPlanner: { replicas: 0 },
          bloomBuilder: { replicas: 0 },
          bloomGateway: { replicas: 0 },

          minio: { enabled: false },

          gateway: {
            service: {
              type: 'ClusterIP',
            },
            resources: tinyResources,
            ingress: ingress
              ? {
                  enabled: ingress.enabled ?? true,
                  ingressClassName: ingress.className ?? 'traefik',
                  hosts: [
                    {
                      host: ingress.host,
                      paths: [
                        {
                          path: '/',
                          pathType: 'Prefix',
                        },
                      ],
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
              : {
                  enabled: false,
                },
          },

          resultsCache: {
            resources: tinyResources,
          },

          chunksCache: {
            resources: tinyResources,
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
