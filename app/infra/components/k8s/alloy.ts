import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface AlloyStackArgs {
  provider: k8s.Provider;
  namespace?: string;
  /** Loki push URL (gateway or distributor). */
  lokiPushUrl?: string;
  extraValues?: pulumi.Inputs;
}

/**
 * Grafana Alloy DaemonSet — ships cluster pod logs, k8s events, and host
 * /var/log into Loki so Grafana Explore → Loki has data.
 */
export class AlloyStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly release: k8s.helm.v3.Release;

  constructor(name: string, args: AlloyStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:AlloyStack', name, {}, opts);

    const nsName = args.namespace ?? 'alloy';
    const lokiPushUrl =
      args.lokiPushUrl ?? 'http://loki-gateway.loki.svc.cluster.local/loki/api/v1/push';

    this.namespace = new k8s.core.v1.Namespace(
      nsName,
      { metadata: { name: nsName } },
      { provider: args.provider, parent: this },
    );

    // River config: pod logs + cluster events + host /var/log → Loki.
    const alloyConfig = `
logging {
  level  = "info"
  format = "logfmt"
}

discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets

  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_node_name"]
    target_label  = "node"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }
}

loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pods.output
  forward_to = [loki.write.default.receiver]
}

loki.source.kubernetes_events "cluster" {
  job_name   = "integrations/kubernetes/eventhandler"
  forward_to = [loki.write.default.receiver]
}

local.file_match "node_logs" {
  path_targets = [
    { __path__ = "/var/log/syslog",   job = "syslog" },
    { __path__ = "/var/log/messages", job = "messages" },
    { __path__ = "/var/log/*.log",    job = "varlogs" },
  ]
}

loki.source.file "node_logs" {
  targets    = local.file_match.node_logs.targets
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "${lokiPushUrl}"
  }
}
`.trim();

    this.release = new k8s.helm.v3.Release(
      name,
      {
        name: 'alloy',
        chart: 'alloy',
        version: '1.16.0',
        namespace: this.namespace.metadata.name,
        repositoryOpts: {
          repo: 'https://grafana.github.io/helm-charts',
        },
        timeout: 600,
        values: {
          fullnameOverride: 'alloy',
          controller: {
            type: 'daemonset',
            tolerations: [{ operator: 'Exists' }],
          },
          alloy: {
            configMap: {
              content: alloyConfig,
            },
            mounts: {
              varlog: true,
            },
            resources: {
              requests: { cpu: '25m', memory: '64Mi' },
              limits: { cpu: '200m', memory: '256Mi' },
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
      namespace: this.namespace.metadata.name,
      release: this.release.name,
    });
  }
}
