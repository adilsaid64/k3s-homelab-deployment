import * as pulumi from '@pulumi/pulumi';

export interface ExcalidrawIngressArgs {
  enabled?: boolean;
  host: string;
  className?: string;
  tlsSecretName?: string;
}

export interface ResourceRequirementsArgs {
  requests?: {
    cpu?: pulumi.Input<string>;
    memory?: pulumi.Input<string>;
  };
  limits?: {
    cpu?: pulumi.Input<string>;
    memory?: pulumi.Input<string>;
  };
}

export interface PodPlacementArgs {
  nodeSelector?: Record<string, string>;
  tolerations?: kubernetes.types.input.core.v1.Toleration[];
  resources?: ResourceRequirementsArgs;
}

export interface ExcalidrawArgs {
  provider: kubernetes.Provider;
  namespace?: string;
  ingress?: ExcalidrawIngressArgs;
  pod?: PodPlacementArgs;
}

export class Excalidraw extends pulumi.ComponentResource {
  readonly namespace: kubernetes.core.v1.Namespace;
  readonly deployment: kubernetes.apps.v1.Deployment;
  readonly service: kubernetes.core.v1.Service;
  readonly ingress?: kubernetes.networking.v1.Ingress;

  constructor(name: string, args: ExcalidrawArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:Excalidraw', name, {}, opts);

    const nsName = args.namespace ?? name;

    this.namespace = new kubernetes.core.v1.Namespace(
      nsName,
      { metadata: { name: nsName } },
      { provider: args.provider, parent: this },
    );

    const podConfig = (p?: PodPlacementArgs) =>
      p
        ? {
            nodeSelector: p.nodeSelector,
            tolerations: p.tolerations,
          }
        : {};

    this.deployment = new kubernetes.apps.v1.Deployment(
      name,
      {
        metadata: {
          namespace: nsName,
          labels: { app: name },
        },
        spec: {
          replicas: 1,
          selector: {
            matchLabels: { app: name },
          },
          template: {
            metadata: {
              labels: { app: name },
            },
            spec: {
              containers: [
                {
                  name: 'excalidraw',
                  image: 'excalidraw/excalidraw:latest',
                  ports: [{ containerPort: 80 }],
                  resources: args.pod?.resources,
                },
              ],
              ...podConfig(args.pod),
            },
          },
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.namespace },
    );

    this.service = new kubernetes.core.v1.Service(
      name,
      {
        metadata: {
          namespace: nsName,
        },
        spec: {
          selector: { app: name },
          ports: [
            {
              port: 80,
              targetPort: 80,
            },
          ],
        },
      },
      { provider: args.provider, parent: this },
    );

    if (args.ingress?.enabled) {
      this.ingress = new kubernetes.networking.v1.Ingress(
        name,
        {
          metadata: {
            namespace: nsName,
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
                          name: this.service.metadata.name,
                          port: { number: 80 },
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
        { provider: args.provider, parent: this },
      );
    }

    this.registerOutputs({
      namespace: this.namespace.metadata.name,
    });
  }
}
