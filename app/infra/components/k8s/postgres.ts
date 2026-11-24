import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface PostgresStackArgs {
  provider: k8s.Provider;
  namespace?: string;
  /** Cluster admin role created by initdb (default `postgres`). */
  username?: string;
  password: pulumi.Input<string>;
  image?: string;
  persistenceSize?: string;
}

export interface CreateDbArgs {
  /** Database name to create. */
  database: string;
  /** Login role that owns the database. */
  username: string;
  password: pulumi.Input<string>;
}

/** Connection info for a database provisioned via {@link PostgresStack.createDb}. */
export interface PostgresDatabase {
  host: pulumi.Output<string>;
  port: number;
  database: string;
  username: string;
  password: pulumi.Input<string>;
  /** Becomes complete once CREATE ROLE/DATABASE has succeeded. */
  ready: pulumi.Resource;
}

/**
 * Shared Postgres for homelab apps.
 * Official image only — no Bitnami / Helm subchart.
 *
 * Notes for this cluster (Ubuntu 26.04 + containerd AppArmor stacking):
 * - Default cri-containerd profile denies signals between container processes
 *   (`could not signal for checkpoint: Permission denied`). Use Unconfined.
 * - Image entrypoint `gosu` also hangs under that profile, so we start as
 *   uid 999 and run initdb/postgres directly.
 *
 * App databases are not created at init — call {@link createDb} from each consumer.
 */
export class PostgresStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly service: k8s.core.v1.Service;
  readonly serviceName: pulumi.Output<string>;
  /** Cluster DNS: `<service>.<namespace>.svc.cluster.local` */
  readonly host: pulumi.Output<string>;
  readonly port = 5432;
  /** Superuser / initdb role. */
  readonly username: string;
  readonly password: pulumi.Input<string>;

  private readonly provider: k8s.Provider;
  private readonly nsName: string;
  private readonly image: string;
  private readonly sts: k8s.apps.v1.StatefulSet;
  private readonly adminSecret: k8s.core.v1.Secret;

  constructor(name: string, args: PostgresStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:PostgresStack', name, {}, opts);

    this.provider = args.provider;
    this.nsName = args.namespace ?? 'postgres';
    const labels = { app: name };
    this.username = args.username ?? 'postgres';
    this.password = args.password;
    this.image = args.image ?? 'postgres:16-bookworm';
    const pgUid = 999;

    this.namespace = new k8s.core.v1.Namespace(
      this.nsName,
      { metadata: { name: this.nsName } },
      { provider: args.provider, parent: this },
    );

    this.adminSecret = new k8s.core.v1.Secret(
      `${name}-credentials`,
      {
        metadata: {
          name: `${name}-credentials`,
          namespace: this.nsName,
        },
        stringData: {
          POSTGRES_DB: 'postgres',
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
  echo "Postgres init complete"
fi

exec postgres -D "\$PGDATA" -c listen_addresses='*'
`;

    const config = new k8s.core.v1.ConfigMap(
      `${name}-start`,
      {
        metadata: {
          name: `${name}-start`,
          namespace: this.nsName,
        },
        data: {
          'start.sh': startScript,
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.namespace },
    );

    this.sts = new k8s.apps.v1.StatefulSet(
      `${name}-sts`,
      {
        metadata: {
          name,
          namespace: this.nsName,
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
                  image: this.image,
                  command: ['bash', '/scripts/start.sh'],
                  ports: [{ name: 'postgres', containerPort: 5432 }],
                  envFrom: [{ secretRef: { name: this.adminSecret.metadata.name } }],
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
                      command: ['pg_isready', '-U', this.username, '-d', 'postgres'],
                    },
                    failureThreshold: 60,
                    periodSeconds: 5,
                  },
                  readinessProbe: {
                    exec: {
                      command: ['pg_isready', '-U', this.username, '-d', 'postgres'],
                    },
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    exec: {
                      command: ['pg_isready', '-U', this.username, '-d', 'postgres'],
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
        dependsOn: [this.namespace, this.adminSecret, config],
      },
    );

    this.service = new k8s.core.v1.Service(
      `${name}-svc`,
      {
        metadata: {
          name,
          namespace: this.nsName,
          labels,
        },
        spec: {
          selector: labels,
          ports: [{ name: 'postgres', port: 5432, targetPort: 'postgres' }],
        },
      },
      { provider: args.provider, parent: this, dependsOn: this.sts },
    );

    this.serviceName = this.service.metadata.name;
    this.host = pulumi.interpolate`${this.serviceName}.${this.nsName}.svc.cluster.local`;

    this.registerOutputs({
      namespace: this.namespace.metadata.name,
      serviceName: this.serviceName,
      host: this.host,
      username: this.username,
    });
  }

  /**
   * Idempotently create a database + login role for an application.
   * Runs a one-shot Job in the Postgres namespace against the admin credentials.
   */
  createDb(
    name: string,
    args: CreateDbArgs,
    opts?: pulumi.ComponentResourceOptions,
  ): PostgresDatabase {
    const parent = opts?.parent ?? this;

    const dbSecret = new k8s.core.v1.Secret(
      `${name}-creds`,
      {
        metadata: {
          name: `${name}-creds`,
          namespace: this.nsName,
        },
        stringData: {
          DATABASE: args.database,
          USERNAME: args.username,
          PASSWORD: args.password,
        },
      },
      { provider: this.provider, parent, dependsOn: this.namespace },
    );

    const job = new k8s.batch.v1.Job(
      `${name}-create`,
      {
        metadata: {
          name: `${name}-create`,
          namespace: this.nsName,
          annotations: {
            'pulumi.com/patchForce': 'true',
          },
        },
        spec: {
          backoffLimit: 6,
          ttlSecondsAfterFinished: 600,
          template: {
            spec: {
              restartPolicy: 'OnFailure',
              containers: [
                {
                  name: 'createdb',
                  image: this.image,
                  env: [
                    { name: 'PGHOST', value: this.host },
                    { name: 'PGPORT', value: String(this.port) },
                    { name: 'PGUSER', value: this.username },
                    { name: 'PGDATABASE', value: 'postgres' },
                    {
                      name: 'PGPASSWORD',
                      valueFrom: {
                        secretKeyRef: {
                          name: this.adminSecret.metadata.name,
                          key: 'POSTGRES_PASSWORD',
                        },
                      },
                    },
                    {
                      name: 'APP_DB',
                      valueFrom: {
                        secretKeyRef: { name: dbSecret.metadata.name, key: 'DATABASE' },
                      },
                    },
                    {
                      name: 'APP_USER',
                      valueFrom: {
                        secretKeyRef: { name: dbSecret.metadata.name, key: 'USERNAME' },
                      },
                    },
                    {
                      name: 'APP_PASSWORD',
                      valueFrom: {
                        secretKeyRef: { name: dbSecret.metadata.name, key: 'PASSWORD' },
                      },
                    },
                  ],
                  command: [
                    'bash',
                    '-ec',
                    [
                      'set -euo pipefail',
                      'until pg_isready -q; do echo "waiting for postgres..."; sleep 2; done',
                      // Escape ' for SQL string literals; identifiers come from our code (safe).
                      'esc() { printf "%s" "$1" | sed "s/\'/\'\'/g"; }',
                      'PASS_SQL=$(esc "$APP_PASSWORD")',
                      'if [ "$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname=\'$APP_USER\'")" = "1" ]; then',
                      '  psql -v ON_ERROR_STOP=1 -c "ALTER ROLE \\"$APP_USER\\" WITH LOGIN PASSWORD \'$PASS_SQL\'"',
                      'else',
                      '  psql -v ON_ERROR_STOP=1 -c "CREATE ROLE \\"$APP_USER\\" LOGIN PASSWORD \'$PASS_SQL\'"',
                      'fi',
                      'if [ "$(psql -tAc "SELECT 1 FROM pg_database WHERE datname=\'$APP_DB\'")" != "1" ]; then',
                      '  psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \\"$APP_DB\\" OWNER \\"$APP_USER\\""',
                      'fi',
                      'psql -v ON_ERROR_STOP=1 -c "GRANT ALL PRIVILEGES ON DATABASE \\"$APP_DB\\" TO \\"$APP_USER\\""',
                      'echo "database $APP_DB ready for $APP_USER"',
                    ].join('\n'),
                  ],
                },
              ],
            },
          },
        },
      },
      {
        provider: this.provider,
        parent,
        dependsOn: [this.sts, this.service, this.adminSecret, dbSecret],
        deleteBeforeReplace: true,
      },
    );

    return {
      host: this.host,
      port: this.port,
      database: args.database,
      username: args.username,
      password: args.password,
      ready: job,
    };
  }
}
