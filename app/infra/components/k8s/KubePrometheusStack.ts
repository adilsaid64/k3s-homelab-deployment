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

export interface KubePrometheusStackArgs {
  provider: kubernetes.Provider;
  namespace?: string;
  grafana?: {
    enabled?: boolean;
    ingress?: GrafanaIngressArgs;
    scheduling?: SchedulingArgs;
  };
  prometheus?: {
    retention?: string;
    scrapeInterval?: string;
    scheduling?: SchedulingArgs;
  };
  alertmanager?: {
    enabled?: boolean;
    scheduling?: SchedulingArgs;
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

    const scheduling = (s?: SchedulingArgs) =>
      s
        ? {
            nodeSelector: s.nodeSelector,
            tolerations: s.tolerations,
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
          nodeExporter: {
            tolerations: [
              {
                operator: 'Exists',
                effect: 'NoSchedule',
              },
              {
                operator: 'Exists',
                effect: 'NoExecute',
              },
            ],
          },
          prometheus: {
            prometheusSpec: {
              retention: args.prometheus?.retention ?? '10d',
              scrapeInterval: args.prometheus?.scrapeInterval ?? '30s',
              evaluationInterval: '30s',
              serviceMonitorSelectorNilUsesHelmValues: false,
              podMonitorSelectorNilUsesHelmValues: false,
              ...scheduling(args.prometheus?.scheduling),
            },
          },
          grafana: {
            enabled: args.grafana?.enabled ?? true,
            ...scheduling(args.grafana?.scheduling),
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
              ...scheduling(args.alertmanager?.scheduling),
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
