import { KubePrometheusStack } from '../components/k8s/KubePrometheusStack';

const k8sProvider = new kubernetes.Provider('k3s');

export const kubePromStack = new KubePrometheusStack('monitoring', {
    provider: k8sProvider,
    namespace: 'monitoring',
    grafana: {
        ingress: {
            host: 'grafana.k3s.local',
            className: 'traefik',
        },
    },
    prometheus: {
        retention: '5d',
        scrapeInterval: '120s',
    },
});
