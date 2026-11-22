import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface PostgresStackArgs {
  provider: k8s.Provider;
  namespace?: string;
  /** Default database created on first boot. */
  database?: string;
  username?: string;
  password: pulumi.Input<string>;
  image?: string;
  persistenceSize?: string;
}

/**
 * Standalone Postgres for shared app use (Authentik, etc.).
 * Official image only — no Bitnami / Helm subchart.
 *
 * Notes for this cluster (Ubuntu 26.04 + containerd AppArmor stacking):
 * - Default cri-containerd profile denies signals between container processes
 *   (`could not signal for checkpoint: Permission denied`). Use Unconfined.
 * - Image entrypoint `gosu` also hangs under that profile, so we start as
 *   uid 999 and run initdb/postgres directly.
 */
export class PostgresStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly service: k8s.core.v1.Service;
  readonly serviceName: pulumi.Output<string>;
  /** Cluster DNS: `<service>.<namespace>.svc.cluster.local` */
  readonly host: pulumi.Output<string>;
  readonly database: string;
  readonly username: string;
  readonly password: pulumi.Input<string>;

  constructor(name: string, args: PostgresStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:PostgresStack', name, {}, opts);

    const nsName = args.namespace ?? 'postgres';
    const labels = { app: name };
    this.database = args.database ?? 'postgres';
    this.username = args.username ?? 'postgres';
    this.password = args.password;
    const image = args.image ?? 'postgres:16-bookworm';
    const pgUid = 999;

    this.namespace = new k8s.core.v1.Namespace(
      nsName,
      { metadata: { name: nsName } },
      { provider: args.provider, parent: this },
    );

    const secret = new k8s.core.v1.Secret(
      `${name}-credentials`,
      {
        metadata: {
          name: `${name}-credentials`,
          namespace: nsName,
        },
        stringData: {
          POSTGRES_DB: this.database,
          POSTGRES_USER: this.username,
          POSTGRES_PASSWORD: args.password,
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.namespace },
    );

    const startScript = `#!/bin/bash
set -euo pipefail
export PATH="/usr/lib/postgresql/16/bin:\${PATH}"
PGDATA="\${PGDATA:-/var/lib/postgresql/data/pgdata}"
mkdir -p "\$PGDATA"
chmod 700 "\$PGDATA"

if [ ! -s "\$PGDATA/PG_VERSION" ]; then
  echo "Initializing new Postgres cluster in \$PGDATA"
  initdb -D "\$PGDATA" --username="\$POSTGRES_USER" --pwfile=<(printf '%s\\n' "\$POSTGRES_PASSWORD")
  echo "listen_addresses = '*'" >> "\$PGDATA/postgresql.conf"
  echo "host all all all scram-sha-256" >> "\$PGDATA/pg_hba.conf"

  pg_ctl -D "\$PGDATA" -o "-c listen_addresses='127.0.0.1'" -w start
  # initdb only creates "postgres"; always ensure POSTGRES_DB exists
  # (even when it matches the username — Authentik uses database=authentik).
  if [ "\$POSTGRES_DB" != "postgres" ]; then
    createdb -U "\$POSTGRES_USER" "\$POSTGRES_DB" || true
  fi
  pg_ctl -D "\$PGDATA" -m fast -w stop
  echo "Postgres init complete"
fi

exec postgres -D "\$PGDATA" -c listen_addresses='*'
`;

    const config = new k8s.core.v1.ConfigMap(
      `${name}-start`,
      {
        metadata: {
          name: `${name}-start`,
          namespace: nsName,
        },
        data: {
          'start.sh': startScript,
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.namespace },
    );

    const sts = new k8s.apps.v1.StatefulSet(
      `${name}-sts`,
      {
        metadata: {
          name,
          namespace: nsName,
          labels,
          annotations: {
            'pulumi.com/patchForce': 'true',
          },
        },
        spec: {
          serviceName: name,
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              securityContext: {
                runAsUser: pgUid,
                runAsGroup: pgUid,
                fsGroup: pgUid,
                // Required on Ubuntu 26.04 kernels where stacked AppArmor
                // (`cri-containerd.apparmor.d//&unconfined`) blocks kill(2).
                appArmorProfile: { type: 'Unconfined' },
              },
              containers: [
                {
                  name: 'postgresql',
                  image,
                  command: ['bash', '/scripts/start.sh'],
                  ports: [{ name: 'postgres', containerPort: 5432 }],
                  envFrom: [{ secretRef: { name: secret.metadata.name } }],
                  env: [{ name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }],
                  volumeMounts: [
                    { name: 'data', mountPath: '/var/lib/postgresql/data' },
                    { name: 'scripts', mountPath: '/scripts', readOnly: true },
                  ],
                  resources: {
                    requests: { cpu: '50m', memory: '256Mi' },
                    limits: { cpu: '1000m', memory: '1Gi' },
                  },
                  startupProbe: {
                    exec: {
                      command: ['pg_isready', '-U', this.username, '-d', this.database],
                    },
                    failureThreshold: 60,
                    periodSeconds: 5,
                  },
                  readinessProbe: {
                    exec: {
                      command: ['pg_isready', '-U', this.username, '-d', this.database],
                    },
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    exec: {
                      command: ['pg_isready', '-U', this.username, '-d', this.database],
                    },
                    periodSeconds: 30,
                    failureThreshold: 6,
                  },
                },
              ],
              volumes: [
                {
                  name: 'scripts',
                  configMap: {
                    name: config.metadata.name,
                    defaultMode: 0o755,
                  },
                },
              ],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: 'data' },
              spec: {
                accessModes: ['ReadWriteOnce'],
                resources: {
                  requests: {
                    storage: args.persistenceSize ?? '10Gi',
                  },
                },
              },
            },
          ],
        },
      },
      {
        provider: args.provider,
        parent: this,
        dependsOn: [this.namespace, secret, config],
      },
    );

    this.service = new k8s.core.v1.Service(
      `${name}-svc`,
      {
        metadata: {
          name,
          namespace: nsName,
          labels,
        },
        spec: {
          selector: labels,
          ports: [{ name: 'postgres', port: 5432, targetPort: 'postgres' }],
        },
      },
      { provider: args.provider, parent: this, dependsOn: sts },
    );

    this.serviceName = this.service.metadata.name;
    this.host = pulumi.interpolate`${this.serviceName}.${nsName}.svc.cluster.local`;

    this.registerOutputs({
      namespace: this.namespace.metadata.name,
      serviceName: this.serviceName,
      host: this.host,
      database: this.database,
      username: this.username,
    });
  }
}
