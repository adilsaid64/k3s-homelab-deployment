import * as path from 'node:path';
import * as command from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

export interface HomelabSsoArgs {
  authentikUrl: pulumi.Input<string>;
  authentikToken: pulumi.Input<string>;
  authentikInternalUrl?: pulumi.Input<string>;
}

/**
 * Homelab SSO via Authentik API — native OIDC only (Grafana).
 * Apps without first-class SSO keep their own login (no forward-auth).
 */
export class HomelabSso extends pulumi.ComponentResource {
  readonly grafanaClientId = 'grafana';
  readonly grafanaClientSecret: pulumi.Output<string>;
  readonly configure: command.local.Command;
  /** Non-secret grafana.ini keys (OAuth secret goes via `grafanaEnv`). */
  readonly grafanaIni: pulumi.Output<pulumi.Inputs>;
  /** Grafana Helm `env` map including OAuth client secret. */
  readonly grafanaEnv: pulumi.Output<Record<string, string>>;

  constructor(name: string, args: HomelabSsoArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:authentik:HomelabSso', name, {}, opts);

    const grafanaSecret = new random.RandomPassword(
      `${name}-grafana-client-secret`,
      { length: 64, special: false },
      { parent: this },
    );
    this.grafanaClientSecret = grafanaSecret.result;

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
          GRAFANA_CLIENT_SECRET: grafanaSecret.result,
        },
      },
      { parent: this },
    );

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

    this.registerOutputs({
      grafanaClientId: this.grafanaClientId,
    });
  }
}
