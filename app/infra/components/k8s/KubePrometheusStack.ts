import * as pulumi from '@pulumi/pulumi';

export interface GrafanaIngressArgs {
  enabled?: boolean;
  host: string;
  className?: string;
  tlsSecretName?: string;
}

export interface SchedulingArgs {
  nodeSelector?: Record<string, string>;
  tolerations?: kubernetes.types.input.core.v1.Toleration[];
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

export interface KubePrometheusStackArgs {
  provider: kubernetes.Provider;
  namespace?: string;
  grafana?: {
    enabled?: boolean;
    ingress?: GrafanaIngressArgs;
    scheduling?: SchedulingArgs;
    pod?: PodPlacementArgs;
  };
  prometheus?: {
    retention?: string;
    scrapeInterval?: string;
    scheduling?: SchedulingArgs;
    pod?: PodPlacementArgs;
  };
  alertmanager?: {
    enabled?: boolean;
    scheduling?: SchedulingArgs;
    pod?: PodPlacementArgs;
  };
  extraValues?: pulumi.Inputs;
}

export class KubePrometheusStack extends pulumi.ComponentResource {
  readonly namespace: kubernetes.core.v1.Namespace;
  readonly release: kubernetes.helm.v3.Release;

  constructor(name: string, args: KubePrometheusStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:KubePrometheusStack', name, {}, opts);

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

    const podConfig = (p?: PodPlacementArgs) =>
      p
        ? {
          nodeSelector: p.nodeSelector,
          tolerations: p.tolerations,
          resources: p.resources,
        }
        : {};

    const grafanaIngress = args.grafana?.ingress;

    this.release = new kubernetes.helm.v3.Release(
      name,
      {
        chart: 'kube-prometheus-stack',
        version: '81.5.0',
        namespace: this.namespace.metadata.name,
        repositoryOpts: {
          repo: 'https://prometheus-community.github.io/helm-charts',
        },
        values: {
          'prometheus-node-exporter': {
            tolerations: [
              { operator: 'Exists' },
            ],
          },
          prometheus: {
            prometheusSpec: {
              retention: args.prometheus?.retention ?? '10d',
              scrapeInterval: args.prometheus?.scrapeInterval ?? '30s',
              evaluationInterval: '30s',
              serviceMonitorSelectorNilUsesHelmValues: false,
              podMonitorSelectorNilUsesHelmValues: false,
              ...podConfig(args.prometheus?.pod),
            },
          },

          grafana: {
            enabled: args.grafana?.enabled ?? true,
            ...podConfig(args.grafana?.pod),
            ingress: grafanaIngress
              ? {
                enabled: grafanaIngress.enabled ?? true,
                ingressClassName: grafanaIngress.className ?? 'traefik',
                hosts: [grafanaIngress.host],
                paths: ['/'],
                tls: grafanaIngress.tlsSecretName
                  ? [
                    {
                      secretName: grafanaIngress.tlsSecretName,
                      hosts: [grafanaIngress.host],
                    },
                  ]
                  : [],
              }
              : { enabled: false },
          },

          alertmanager: {
            enabled: args.alertmanager?.enabled ?? true,
            alertmanagerSpec: {
              ...podConfig(args.alertmanager?.pod),
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

    this.registerOutputs({
      release: this.release.name,
      namespace: this.namespace.metadata.name,
    });
  }
}
