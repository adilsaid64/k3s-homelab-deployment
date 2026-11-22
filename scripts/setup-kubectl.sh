#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${1:-dev}"
KUBE_DIR="${HOME}/.kube"
KUBECONFIG_PATH="${KUBECONFIG:-${KUBE_DIR}/config}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_PRIVATE_KEY_PATH="${SSH_PRIVATE_KEY_PATH:-${HOME}/.ssh/id_ed25519}"
CONTEXT_NAME="${KUBE_CONTEXT:-${STAGE}}"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi

mkdir -p "${KUBE_DIR}"
chmod 700 "${KUBE_DIR}"

install_kubectl_if_needed() {
  if command -v kubectl >/dev/null 2>&1; then
    return 0
  fi

  echo "kubectl not found; installing..."
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/kubectl" "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
  chmod +x "${tmp}/kubectl"
  if [[ -w /usr/local/bin ]]; then
    mv "${tmp}/kubectl" /usr/local/bin/kubectl
  else
    mkdir -p "${HOME}/.local/bin"
    mv "${tmp}/kubectl" "${HOME}/.local/bin/kubectl"
    export PATH="${HOME}/.local/bin:${PATH}"
    echo "Installed kubectl to ~/.local/bin (ensure that directory is on your PATH)"
  fi
  rm -rf "${tmp}"
}

write_kubeconfig() {
  local contents="$1"
  if [[ -f "${KUBECONFIG_PATH}" ]]; then
    cp "${KUBECONFIG_PATH}" "${KUBECONFIG_PATH}.bak.$(date +%Y%m%d%H%M%S)"
    echo "Backed up existing kubeconfig to ${KUBECONFIG_PATH}.bak.*"
  fi
  printf '%s\n' "${contents}" >"${KUBECONFIG_PATH}"
  chmod 600 "${KUBECONFIG_PATH}"
}

fetch_from_sst_outputs() {
  local outputs="${ROOT_DIR}/.sst/outputs.json"
  if [[ ! -f "${outputs}" ]]; then
    return 1
  fi

  python3 - "${outputs}" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)

kubeconfig = data.get("kubeconfig")
if not kubeconfig:
    raise SystemExit(1)

print(kubeconfig, end="" if kubeconfig.endswith("\n") else "\n")
PY
}

fetch_from_master() {
  local master_ip="${MASTER_IP:-}"
  if [[ -z "${master_ip}" && -f "${ROOT_DIR}/.sst/outputs.json" ]]; then
    master_ip="$(python3 - <<'PY'
import json
from pathlib import Path
print(json.loads(Path(".sst/outputs.json").read_text())["k3MasterIp"])
PY
)"
  fi

  if [[ -z "${master_ip}" ]]; then
    echo "MASTER_IP is not set and .sst/outputs.json has no k3MasterIp" >&2
    return 1
  fi

  echo "Fetching kubeconfig from ${SSH_USER}@${master_ip}..."
  local raw
  raw="$(
    ssh -i "${SSH_PRIVATE_KEY_PATH}" \
      -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="${HOME}/.ssh/known_hosts" \
      "${SSH_USER}@${master_ip}" \
      'sudo cat /etc/rancher/k3s/k3s.yaml'
  )"

  MASTER_IP="${master_ip}" python3 - <<'PY' <<<"${raw}"
import os
import sys

cfg = sys.stdin.read()
ip = os.environ["MASTER_IP"]
cfg = cfg.replace("https://127.0.0.1:6443", f"https://{ip}:6443")
cfg = cfg.replace("https://localhost:6443", f"https://{ip}:6443")
print(cfg, end="" if cfg.endswith("\n") else "\n")
PY
}

main() {
  cd "${ROOT_DIR}"
  install_kubectl_if_needed

  local kubeconfig=""
  if kubeconfig="$(fetch_from_sst_outputs)"; then
    echo "Using kubeconfig from .sst/outputs.json"
  else
    echo ".sst/outputs.json unavailable; falling back to SSH"
    kubeconfig="$(fetch_from_master)"
  fi

  write_kubeconfig "${kubeconfig}"

  # Normalize context name to the stage when still called "default".
  local current
  current="$(kubectl --kubeconfig "${KUBECONFIG_PATH}" config current-context)"
  if [[ "${current}" == "default" && "${CONTEXT_NAME}" != "default" ]]; then
    kubectl --kubeconfig "${KUBECONFIG_PATH}" config rename-context default "${CONTEXT_NAME}" >/dev/null
    echo "Renamed context default -> ${CONTEXT_NAME}"
  fi

  echo
  kubectl --kubeconfig "${KUBECONFIG_PATH}" config get-contexts
  echo
  kubectl --kubeconfig "${KUBECONFIG_PATH}" get nodes -o wide
  echo
  echo "kubectl is ready (config: ${KUBECONFIG_PATH}, context: ${CONTEXT_NAME})"
}

main "$@"
