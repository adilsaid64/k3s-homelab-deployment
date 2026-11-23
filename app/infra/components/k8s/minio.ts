import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface MinioIngressArgs {
  enabled?: boolean;
  host: string;
  className?: string;
  tlsSecretName?: string;
  annotations?: Record<string, string>;
}

export interface MinioStackArgs {
  provider: k8s.Provider;
  namespace: string;
  rootUser?: pulumi.Input<string>;
  rootPassword?: pulumi.Input<string>;
  persistenceSize?: string;
  image?: string;
  ingress?: MinioIngressArgs;
  /** Extra container env (e.g. Authentik OIDC). */
  extraEnv?: pulumi.Input<k8s.types.input.core.v1.EnvVar[]>;
}

export class MinioStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly service: k8s.core.v1.Service;
  readonly serviceName: pulumi.Output<string>;

  constructor(name: string, args: MinioStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:MinioStack', name, {}, opts);

    const labels = { app: name };
    const rootUser = args.rootUser ?? 'minio';
    const rootPassword = args.rootPassword ?? 'minio123';
    // Official minio/minio and quay.io/minio/minio are no longer publicly pullable.
    const image = args.image ?? 'cgr.dev/chainguard/minio:latest';

    this.namespace = new k8s.core.v1.Namespace(
      args.namespace,
      { metadata: { name: args.namespace } },
      { provider: args.provider, parent: this },
    );

    const secret = new k8s.core.v1.Secret(
      `${name}-creds`,
      {
        metadata: {
          name: `${name}-creds`,
          namespace: args.namespace,
        },
        stringData: {
          rootUser,
          rootPassword,
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.namespace },
    );

    const pvc = new k8s.core.v1.PersistentVolumeClaim(
      `${name}-data`,
      {
        metadata: {
          name: `${name}-data`,
          namespace: args.namespace,
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: {
            requests: {
              storage: args.persistenceSize ?? '5Gi',
            },
          },
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.namespace },
    );

    const deployment = new k8s.apps.v1.Deployment(
      name,
      {
        metadata: {
          name,
          namespace: args.namespace,
          labels,
          annotations: {
            // Take ownership when replacing leftover Helm/SSA-managed fields.
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
                fsGroup: 65532,
                runAsUser: 65532,
                runAsNonRoot: true,
              },
              containers: [
                {
                  name: 'minio',
                  image,
                  args: ['server', '/data', '--console-address', ':9001'],
                  ports: [
                    { name: 'api', containerPort: 9000 },
                    { name: 'console', containerPort: 9001 },
                  ],
                  env: pulumi
                    .all([secret.metadata.name, args.extraEnv ?? []])
                    .apply(([secretName, extra]) => [
                      {
                        name: 'MINIO_ROOT_USER',
                        valueFrom: {
                          secretKeyRef: { name: secretName, key: 'rootUser' },
                        },
                      },
                      {
                        name: 'MINIO_ROOT_PASSWORD',
                        valueFrom: {
                          secretKeyRef: { name: secretName, key: 'rootPassword' },
                        },
                      },
                      ...extra,
                    ]),
                  volumeMounts: [{ name: 'data', mountPath: '/data' }],
                  resources: {
                    requests: { cpu: '100m', memory: '256Mi' },
                    limits: { cpu: '500m', memory: '512Mi' },
                  },
                  readinessProbe: {
                    httpGet: { path: '/minio/health/ready', port: 'api' },
                    initialDelaySeconds: 10,
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    httpGet: { path: '/minio/health/live', port: 'api' },
                    initialDelaySeconds: 20,
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
        dependsOn: [this.namespace, secret, pvc],
      },
    );

    this.service = new k8s.core.v1.Service(
      name,
      {
        metadata: {
          name,
          namespace: args.namespace,
          labels,
        },
        spec: {
          selector: labels,
          ports: [
            { name: 'api', port: 9000, targetPort: 'api' },
            { name: 'console', port: 9001, targetPort: 'console' },
          ],
        },
      },
      { provider: args.provider, parent: this, dependsOn: deployment },
    );

    this.serviceName = this.service.metadata.name;

    if (args.ingress?.enabled !== false && args.ingress?.host) {
      new k8s.networking.v1.Ingress(
        name,
        {
          metadata: {
            name,
            namespace: args.namespace,
            labels,
            annotations: args.ingress.annotations,
          },
          spec: {
            ingressClassName: args.ingress.className ?? 'traefik',
            rules: [
              {
                host: args.ingress.host,
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: {
                        service: {
                          name,
                          port: { name: 'console' },
                        },
                      },
                    },
                  ],
                },
              },
            ],
            tls: args.ingress.tlsSecretName
              ? [
                  {
                    secretName: args.ingress.tlsSecretName,
                    hosts: [args.ingress.host],
                  },
                ]
              : undefined,
          },
        },
        { provider: args.provider, parent: this, dependsOn: this.service },
      );
    }

    this.registerOutputs({
      namespace: this.namespace.metadata.name,
      serviceName: this.serviceName,
    });
  }
}
