import { KubePrometheusStack } from "../components/k8s/KubePrometheusStack";

const k8sProvider = new kubernetes.Provider("k3s");

export const kubepromstack = new KubePrometheusStack("monitoring", {
    provider: k8sProvider,
});