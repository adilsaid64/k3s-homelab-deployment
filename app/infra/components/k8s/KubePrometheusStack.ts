import * as pulumi from "@pulumi/pulumi";

export interface KubePrometheusStackArgs {
    provider: kubernetes.Provider;
    namespace?: string;
    values?: pulumi.Inputs;
}

export class KubePrometheusStack extends pulumi.ComponentResource {
    readonly namespace: kubernetes.core.v1.Namespace;
    readonly release: kubernetes.helm.v3.Release;

    constructor(
        name: string,
        args: KubePrometheusStackArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super("infra:k8s:KubePrometheusStack", name, {}, opts);

        const namespaceName = args.namespace ?? "monitoring";

        this.namespace = new kubernetes.core.v1.Namespace(
            namespaceName,
            {
                metadata: {
                    name: namespaceName,
                },
            },
            {
                provider: args.provider,
                parent: this,
            },
        );

        this.release = new kubernetes.helm.v3.Release(
            name,
            {
                chart: "kube-prometheus-stack",
                version: "81.5.0",
                namespace: namespaceName,
                repositoryOpts: {
                    repo: "https://prometheus-community.github.io/helm-charts",
                },
                values: {
                    prometheus: {
                        prometheusSpec: {
                            serviceMonitorSelectorNilUsesHelmValues: false,
                            podMonitorSelectorNilUsesHelmValues: false,
                        },
                    },

                    grafana: {
                        enabled: true,
                        ingress: {
                            enabled: true,
                            ingressClassName: "traefik",
                            hosts: ["grafana.k3s.local"],
                            paths: ["/"],
                        },
                    },

                    alertmanager: {
                        enabled: true,
                    },

                    ...args.values,
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
        });
    }
}