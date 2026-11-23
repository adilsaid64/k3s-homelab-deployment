import * as path from 'node:path';
import * as command from '@pulumi/command';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

export interface HomelabSsoArgs {
  provider: k8s.Provider;
  authentikUrl: pulumi.Input<string>;
  authentikToken: pulumi.Input<string>;
  /** Namespaces that need a local Traefik Middleware (no cross-ns refs). */
  forwardAuthNamespaces: string[];
  authentikInternalUrl?: pulumi.Input<string>;
}

const AUTH_RESPONSE_HEADERS = [
  'X-authentik-username',
  'X-authentik-groups',
  'X-authentik-entitlements',
  'X-authentik-email',
  'X-authentik-name',
  'X-authentik-uid',
  'X-authentik-jwt',
  'X-authentik-meta-jwks',
  'X-authentik-meta-outpost',
  'X-authentik-meta-provider',
  'X-authentik-meta-app',
  'X-authentik-meta-version',
];

/**
 * Homelab SSO via Authentik API:
 * - OIDC for Grafana + MinIO
 * - Domain forward-auth for Excalidraw / Tempo / Loki / EMQX UI
 * - Traefik Middleware CR in each protected namespace
 */
export class HomelabSso extends pulumi.ComponentResource {
  readonly grafanaClientId = 'grafana';
  readonly minioClientId = 'minio';
  readonly grafanaClientSecret: pulumi.Output<string>;
  readonly minioClientSecret: pulumi.Output<string>;
  readonly configure: command.local.Command;
  /** Non-secret grafana.ini keys (OAuth secret goes via `grafanaEnv`). */
  readonly grafanaIni: pulumi.Output<pulumi.Inputs>;
  /** Grafana Helm `env` map including OAuth client secret. */
  readonly grafanaEnv: pulumi.Output<Record<string, string>>;
  readonly minioOidcEnv: pulumi.Output<k8s.types.input.core.v1.EnvVar[]>;
  /** Annotation value: `<ns>-authentik@kubernetescrd` */
  middlewareAnnotation(namespace: string): string {
    return `${namespace}-authentik@kubernetescrd`;
  }

  constructor(name: string, args: HomelabSsoArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:authentik:HomelabSso', name, {}, opts);

    const grafanaSecret = new random.RandomPassword(
      `${name}-grafana-client-secret`,
      { length: 64, special: false },
      { parent: this },
    );
    const minioSecret = new random.RandomPassword(
      `${name}-minio-client-secret`,
      { length: 64, special: false },
      { parent: this },
    );
    this.grafanaClientSecret = grafanaSecret.result;
    this.minioClientSecret = minioSecret.result;

    const scriptPath = path.resolve(process.cwd(), 'app/infra/scripts/configure-authentik-sso.py');
    this.configure = new command.local.Command(
      `${name}-configure`,
      {
        create: pulumi.interpolate`python3 "${scriptPath}" upsert`,
        update: pulumi.interpolate`python3 "${scriptPath}" upsert`,
        environment: {
          AUTHENTIK_URL: args.authentikUrl,
          AUTHENTIK_TOKEN: args.authentikToken,
          AUTHENTIK_PUBLIC_URL: args.authentikUrl,
          COOKIE_DOMAIN: '.k3s.local',
          GRAFANA_CLIENT_SECRET: grafanaSecret.result,
          MINIO_CLIENT_SECRET: minioSecret.result,
        },
      },
      { parent: this },
    );

    const forwardAuthAddress = pulumi
      .output(args.authentikInternalUrl ?? 'http://authentik-server.authentik.svc.cluster.local')
      .apply((u) => `${u.replace(/\/$/, '')}/outpost.goauthentik.io/auth/traefik`);

    for (const ns of args.forwardAuthNamespaces) {
      new k8s.apiextensions.CustomResource(
        `${name}-mw-${ns}`,
        {
          apiVersion: 'traefik.io/v1alpha1',
          kind: 'Middleware',
          metadata: {
            name: 'authentik',
            namespace: ns,
          },
          spec: {
            forwardAuth: {
              address: forwardAuthAddress,
              trustForwardHeader: true,
              authResponseHeaders: AUTH_RESPONSE_HEADERS,
            },
          },
        },
        {
          provider: args.provider,
          parent: this,
          dependsOn: [this.configure],
          // Namespace may be owned by another component; allow create if missing via app deploy order.
          deleteBeforeReplace: true,
        },
      );
    }

    const external = pulumi.output(args.authentikUrl).apply((u) => u.replace(/\/$/, ''));
    const internal = pulumi
      .output(args.authentikInternalUrl ?? 'http://authentik-server.authentik.svc.cluster.local')
      .apply((u) => u.replace(/\/$/, ''));

    this.grafanaIni = pulumi.all([external, internal]).apply(([ext, int]) => ({
      server: { root_url: 'http://grafana.k3s.local' },
      'auth.generic_oauth': {
        enabled: true,
        name: 'authentik',
        allow_sign_up: true,
        client_id: this.grafanaClientId,
        // client_secret via GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET env (chart secret assert)
        scopes: 'openid profile email',
        auth_url: `${ext}/application/o/authorize/`,
        token_url: `${int}/application/o/token/`,
        api_url: `${int}/application/o/userinfo/`,
        role_attribute_path:
          "contains(groups[*], 'authentik Admins') && 'Admin' || 'Editor'",
        signout_redirect_url: `${ext}/application/o/grafana/end-session/`,
        use_pkce: true,
      },
    }));

    this.grafanaEnv = this.grafanaClientSecret.apply((clientSecret) => ({
      GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET: clientSecret,
    }));

    this.minioOidcEnv = pulumi
      .all([external, this.minioClientSecret])
      .apply(([ext, clientSecret]) => [
        {
          name: 'MINIO_IDENTITY_OPENID_CONFIG_URL',
          value: `${ext}/application/o/minio/.well-known/openid-configuration`,
        },
        { name: 'MINIO_IDENTITY_OPENID_CLIENT_ID', value: this.minioClientId },
        { name: 'MINIO_IDENTITY_OPENID_CLIENT_SECRET', value: clientSecret },
        { name: 'MINIO_IDENTITY_OPENID_DISPLAY_NAME', value: 'authentik' },
        { name: 'MINIO_IDENTITY_OPENID_SCOPES', value: 'openid,profile,email' },
        { name: 'MINIO_IDENTITY_OPENID_REDIRECT_URI', value: 'http://minio.k3s.local/oauth_callback' },
        { name: 'MINIO_BROWSER_REDIRECT_URL', value: 'http://minio.k3s.local' },
        // Homelab: every Authentik user gets full console access.
        { name: 'MINIO_IDENTITY_OPENID_ROLE_POLICY', value: 'consoleAdmin' },
      ]);

    this.registerOutputs({
      grafanaClientId: this.grafanaClientId,
      minioClientId: this.minioClientId,
    });
  }
}
