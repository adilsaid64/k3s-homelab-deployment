import * as pulumi from '@pulumi/pulumi';

export interface MinioIngressArgs {
  enabled?: boolean;
  host: string;
  className?: string;
  tlsSecretName?: string;
}

export interface MinioStackArgs {
  provider: kubernetes.Provider;
  namespace: string;

  rootUser?: pulumi.Input<string>;
  rootPassword?: pulumi.Input<string>;

  persistenceSize?: string;

  ingress?: MinioIngressArgs;
}

export class MinioStack extends pulumi.ComponentResource {
  readonly namespace: kubernetes.core.v1.Namespace;
  readonly release: kubernetes.helm.v3.Release;

  constructor(name: string, args: MinioStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:MinioStack', name, {}, opts);

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

    const ingress = args.ingress;

    this.release = new kubernetes.helm.v3.Release(
      name,
      {
        chart: 'minio',
        version: '14.7.15',
        namespace: this.namespace.metadata.name,
        repositoryOpts: {
          repo: 'https://charts.bitnami.com/bitnami',
        },
        values: {
          mode: 'standalone',

          auth: {
            rootUser: args.rootUser ?? 'minio',
            rootPassword: args.rootPassword ?? 'minio123',
          },

          persistence: {
            enabled: true,
            size: args.persistenceSize ?? '5Gi',
          },

          defaultBuckets: 'chunks,ruler,admin',

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

          ingress: ingress
            ? {
                enabled: ingress.enabled ?? true,
                ingressClassName: ingress.className ?? 'traefik',
                hostname: ingress.host,
                tls: ingress.tlsSecretName ? true : false,
                extraTls: ingress.tlsSecretName
                  ? [
                      {
                        hosts: [ingress.host],
                        secretName: ingress.tlsSecretName,
                      },
                    ]
                  : [],
              }
            : {
                enabled: false,
              },
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
