#!/usr/bin/env bash
set -euo pipefail

: "${PROXMOX_VE_ENDPOINT:?}"
: "${PROXMOX_VE_USERNAME:?}"
: "${PROXMOX_VE_PASSWORD:?}"
: "${PROXMOX_NODE_NAME:?}"

ENDPOINT="${PROXMOX_VE_ENDPOINT%/}"
CURL_OPTS=(-sS)
if [[ "${PROXMOX_VE_INSECURE:-false}" == "true" ]]; then
  CURL_OPTS+=(-k)
fi

json_get() {
  local json="$1"
  local expr="$2"
  PROXMOX_JSON="${json}" python3 -c "import json,os; data=json.loads(os.environ['PROXMOX_JSON']); print(${expr})"
}

ticket_json="$(
  curl "${CURL_OPTS[@]}" -X POST \
    --data-urlencode "username=${PROXMOX_VE_USERNAME}" \
    --data-urlencode "password=${PROXMOX_VE_PASSWORD}" \
    "${ENDPOINT}/api2/json/access/ticket"
)"

ticket="$(json_get "${ticket_json}" "data['data']['ticket']")"
csrf="$(json_get "${ticket_json}" "data['data']['CSRFPreventionToken']")"

if [[ -z "${ticket}" || -z "${csrf}" ]]; then
  echo "failed to authenticate to Proxmox: ${ticket_json}" >&2
  exit 1
fi

storage_json="$(
  curl "${CURL_OPTS[@]}" \
    -H "Cookie: PVEAuthCookie=${ticket}" \
    "${ENDPOINT}/api2/json/storage/local"
)"

content="$(json_get "${storage_json}" "data['data'].get('content','')")"
IFS=',' read -r -a contents <<< "${content}"

has_snippets=false
for item in "${contents[@]+"${contents[@]}"}"; do
  if [[ "${item}" == "snippets" ]]; then
    has_snippets=true
    break
  fi
done

if [[ "${has_snippets}" != "true" ]]; then
  if [[ -n "${content}" ]]; then
    new_content="${content},snippets"
  else
    new_content="snippets"
  fi

  update_json="$(
    curl "${CURL_OPTS[@]}" -X PUT \
      -H "Cookie: PVEAuthCookie=${ticket}" \
      -H "CSRFPreventionToken: ${csrf}" \
      --data-urlencode "content=${new_content}" \
      "${ENDPOINT}/api2/json/storage/local"
  )"

  if [[ "$(json_get "${update_json}" "str('data' in data).lower()")" != "true" ]]; then
    echo "failed to enable snippets on local storage: ${update_json}" >&2
    exit 1
  fi
fi

for _ in 1 2 3 4 5; do
  list_json="$(
    curl "${CURL_OPTS[@]}" \
      -H "Cookie: PVEAuthCookie=${ticket}" \
      "${ENDPOINT}/api2/json/nodes/${PROXMOX_NODE_NAME}/storage/local/content?content=snippets"
  )"
  if [[ "$(json_get "${list_json}" "str('data' in data).lower()")" == "true" ]]; then
    echo "local snippets storage is ready on ${PROXMOX_NODE_NAME}"
    exit 0
  fi
  sleep 1
done

echo "failed to create /var/lib/vz/snippets on ${PROXMOX_NODE_NAME}" >&2
exit 1
