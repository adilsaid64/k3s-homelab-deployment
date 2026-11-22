import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface AuthentikIngressArgs {
  enabled?: boolean;
  host: string;
  className?: string;
  tlsSecretName?: string;
}

export interface AuthentikPostgresArgs {
  host: pulumi.Input<string>;
  port?: pulumi.Input<number>;
  database: pulumi.Input<string>;
  username: pulumi.Input<string>;
  password: pulumi.Input<string>;
}

export interface AuthentikBootstrapArgs {
  /** API token created on first startup for akadmin (AUTHENTIK_BOOTSTRAP_TOKEN). */
  token: pulumi.Input<string>;
  /** Plaintext akadmin password (first startup only). Prefer hash in prod. */
  password: pulumi.Input<string>;
  email?: pulumi.Input<string>;
}

export interface AuthentikStackArgs {
  provider: k8s.Provider;
  namespace?: string;
  /** Min 50 chars. Used to sign sessions / cookies. */
  secretKey: pulumi.Input<string>;
  /** External Postgres (see {@link PostgresStack}). */
  postgres: AuthentikPostgresArgs;
  /** Skips OOBE; only applied when the DB is empty (first startup). */
  bootstrap: AuthentikBootstrapArgs;
  ingress?: AuthentikIngressArgs;
  extraValues?: pulumi.Inputs;
}

/**
 * Authentik IdP for app-layer SSO (Grafana, MinIO, Traefik forward-auth, etc.).
 * Proxmox stays outside this — infra vs app auth layers.
 * Database is provided externally via {@link AuthentikStackArgs.postgres}.
 */
export class AuthentikStack extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly release: k8s.helm.v3.Release;

  constructor(name: string, args: AuthentikStackArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:infra:AuthentikStack', name, {}, opts);

    const nsName = args.namespace ?? 'authentik';

    this.namespace = new k8s.core.v1.Namespace(
      nsName,
      { metadata: { name: nsName } },
      { provider: args.provider, parent: this },
    );

    const ingress = args.ingress;

    this.release = new k8s.helm.v3.Release(
      name,
      {
        name: 'authentik',
        chart: 'authentik',
        version: '2026.8.6',
        namespace: this.namespace.metadata.name,
        repositoryOpts: {
          repo: 'https://charts.goauthentik.io',
        },
        timeout: 900,
        values: {
          authentik: {
            secret_key: args.secretKey,
            bootstrap_token: args.bootstrap.token,
            bootstrap_password: args.bootstrap.password,
            bootstrap_email: args.bootstrap.email ?? 'admin@k3s.local',
            error_reporting: {
              enabled: false,
            },
            postgresql: {
              host: args.postgres.host,
              name: args.postgres.database,
              user: args.postgres.username,
              password: args.postgres.password,
              port: args.postgres.port ?? 5432,
            },
          },
          // Ubuntu 26.04 AppArmor stacking blocks kill(2) between container
          // processes; gunicorn needs SIGUSR1 to the parent or the server exits.
          server: {
            securityContext: {
              appArmorProfile: { type: 'Unconfined' },
            },
            resources: {
              requests: { cpu: '50m', memory: '256Mi' },
              limits: { cpu: '1000m', memory: '1Gi' },
            },
            ingress: ingress
              ? {
                  enabled: ingress.enabled ?? true,
                  ingressClassName: ingress.className ?? 'traefik',
                  hosts: [ingress.host],
                  paths: ['/'],
                  pathType: 'Prefix',
                  tls: ingress.tlsSecretName
                    ? [
                        {
                          secretName: ingress.tlsSecretName,
                          hosts: [ingress.host],
                        },
                      ]
                    : [],
                }
              : { enabled: false },
          },
          worker: {
            securityContext: {
              appArmorProfile: { type: 'Unconfined' },
            },
            resources: {
              requests: { cpu: '50m', memory: '256Mi' },
              limits: { cpu: '1000m', memory: '1Gi' },
            },
          },
          postgresql: {
            enabled: false,
          },
          redis: {
            enabled: false,
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
