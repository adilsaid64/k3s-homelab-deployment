#!/usr/bin/env python3
"""Configure Authentik SSO for the homelab dashboards.

Creates/updates:
  - OAuth2 apps: Grafana, MinIO
  - Domain-level forward-auth proxy provider + apps: Excalidraw, Tempo, Loki, EMQX
  - Assigns proxy provider to the embedded outpost

Env:
  AUTHENTIK_URL, AUTHENTIK_TOKEN (required)
  GRAFANA_CLIENT_SECRET, MINIO_CLIENT_SECRET (required for upsert)
  AUTHENTIK_PUBLIC_URL   default http://auth.k3s.local
  COOKIE_DOMAIN          default .k3s.local
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or value == "":
        raise SystemExit(f"missing required env: {name}")
    return value


class Authentik:
    def __init__(self, base_url: str, token: str) -> None:
        self.base = base_url.rstrip("/") + "/api/v3"
        self.token = token

    def request(self, method: str, path: str, body: dict | None = None) -> dict | list | None:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                if not raw:
                    return None
                return json.loads(raw.decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode()
            raise SystemExit(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc

    def get(self, path: str) -> dict | list | None:
        return self.request("GET", path)

    def post(self, path: str, body: dict) -> dict:
        result = self.request("POST", path, body)
        assert isinstance(result, dict)
        return result

    def patch(self, path: str, body: dict) -> dict:
        result = self.request("PATCH", path, body)
        assert isinstance(result, dict)
        return result

    def list_results(self, path: str) -> list[dict]:
        out: list[dict] = []
        next_path: str | None = path
        while next_path:
            page = self.get(next_path)
            assert isinstance(page, dict)
            out.extend(page.get("results", []))
            nxt = page.get("pagination", {}).get("next")
            if not nxt:
                break
            parsed = urllib.parse.urlparse(next_path)
            qs = urllib.parse.parse_qs(parsed.query)
            qs["page"] = [str(nxt)]
            next_path = parsed.path.replace("/api/v3", "") + "?" + urllib.parse.urlencode(
                qs, doseq=True
            )
            if not next_path.startswith("/"):
                next_path = "/" + next_path
        return out


def find_by(items: list[dict], key: str, value: str) -> dict | None:
    for item in items:
        if item.get(key) == value:
            return item
    return None


def upsert_oauth2(
    ak: Authentik,
    *,
    name: str,
    slug: str,
    client_id: str,
    client_secret: str,
    redirect_url: str,
    launch_url: str,
    logout_uri: str,
    flows: dict[str, str],
    scopes: list[str],
    signing_key: str,
) -> dict:
    body = {
        "name": name,
        "authentication_flow": None,
        "authorization_flow": flows["authz"],
        "invalidation_flow": flows["inval"],
        "client_type": "confidential",
        "client_id": client_id,
        "client_secret": client_secret,
        # Authentik 2026: empty grant_types → "request is otherwise malformed"
        "grant_types": ["authorization_code", "refresh_token"],
        "access_code_validity": "minutes=1",
        "access_token_validity": "minutes=10",
        "refresh_token_validity": "days=30",
        "include_claims_in_id_token": True,
        "signing_key": signing_key,
        "property_mappings": scopes,
        "sub_mode": "hashed_user_id",
        "issuer_mode": "per_provider",
        "redirect_uris": [
            {
                "matching_mode": "strict",
                "url": redirect_url,
                "redirect_uri_type": "authorization",
            }
        ],
        "logout_uri": logout_uri,
        "logout_method": "frontchannel",
    }
    providers = ak.list_results("/providers/oauth2/?page_size=100")
    existing = find_by(providers, "client_id", client_id) or find_by(providers, "name", name)
    if existing:
        provider = ak.patch(f"/providers/oauth2/{existing['pk']}/", body)
        action = "updated"
    else:
        provider = ak.post("/providers/oauth2/", body)
        action = "created"

    app_body = {
        "name": name,
        "slug": slug,
        "provider": provider["pk"],
        "policy_engine_mode": "any",
        "meta_launch_url": launch_url,
        "open_in_new_tab": False,
    }
    apps = ak.list_results("/core/applications/?page_size=100")
    existing_app = find_by(apps, "slug", slug)
    if existing_app:
        app = ak.patch(f"/core/applications/{existing_app['slug']}/", app_body)
        app_action = "updated"
    else:
        app = ak.post("/core/applications/", app_body)
        app_action = "created"

    return {
        "provider": action,
        "application": app_action,
        "client_id": client_id,
        "slug": app["slug"],
        "provider_pk": provider["pk"],
    }


def upsert_proxy_app(
    ak: Authentik,
    *,
    name: str,
    slug: str,
    launch_url: str,
    authentik_public_url: str,
    cookie_domain: str,
    flows: dict[str, str],
) -> dict:
    """Domain forward-auth provider + application (callback stays on Authentik host)."""
    provider_name = f"{name} Forward Auth"
    body = {
        "name": provider_name,
        "authorization_flow": flows["authz"],
        "invalidation_flow": flows["inval"],
        "authentication_flow": flows.get("authn"),
        # Domain mode: external_host = Authentik; cookie covers *.k3s.local
        "external_host": authentik_public_url,
        "mode": "forward_domain",
        "cookie_domain": cookie_domain,
        "access_token_validity": "hours=24",
        "intercept_header_auth": True,
    }
    providers = ak.list_results("/providers/proxy/?page_size=100")
    existing = find_by(providers, "name", provider_name)
    if existing:
        provider = ak.patch(f"/providers/proxy/{existing['pk']}/", body)
        provider_action = "updated"
    else:
        provider = ak.post("/providers/proxy/", body)
        provider_action = "created"

    app_body = {
        "name": name,
        "slug": slug,
        "provider": provider["pk"],
        "policy_engine_mode": "any",
        "meta_launch_url": launch_url,
        "open_in_new_tab": False,
    }
    apps = ak.list_results("/core/applications/?page_size=100")
    existing_app = find_by(apps, "slug", slug)
    if existing_app:
        # Re-bind provider if a previous shared-provider attempt failed mid-way
        app = ak.patch(f"/core/applications/{existing_app['slug']}/", app_body)
        app_action = "updated"
    else:
        app = ak.post("/core/applications/", app_body)
        app_action = "created"

    return {
        "provider": provider_action,
        "application": app_action,
        "slug": app["slug"],
        "provider_pk": provider["pk"],
    }


def assign_proxies_to_embedded_outpost(
    ak: Authentik,
    provider_pks: list[int],
    *,
    authentik_public_url: str,
) -> dict:
    outposts = ak.list_results("/outposts/instances/?page_size=50")
    embedded = find_by(outposts, "name", "authentik Embedded Outpost") or (
        outposts[0] if outposts else None
    )
    if not embedded:
        raise SystemExit("no authentik outpost found")
    providers = list(embedded.get("providers") or [])
    for pk in provider_pks:
        if pk not in providers:
            providers.append(pk)
    # Empty authentik_host makes the outpost redirect browsers to http://localhost/...
    config = dict(embedded.get("config") or {})
    config["authentik_host"] = authentik_public_url
    config["authentik_host_browser"] = authentik_public_url
    config["authentik_host_insecure"] = True
    updated = ak.patch(
        f"/outposts/instances/{embedded['pk']}/",
        {
            "providers": providers,
            "config": config,
        },
    )
    return {
        "outpost": updated.get("name"),
        "providers": updated.get("providers"),
        "authentik_host": (updated.get("config") or {}).get("authentik_host"),
    }


def upsert(ak: Authentik) -> None:
    public = env("AUTHENTIK_PUBLIC_URL", "http://auth.k3s.local").rstrip("/")
    cookie_domain = env("COOKIE_DOMAIN", ".k3s.local")
    grafana_secret = env("GRAFANA_CLIENT_SECRET")
    minio_secret = env("MINIO_CLIENT_SECRET")

    flows_raw = {f["slug"]: f["pk"] for f in ak.list_results("/flows/instances/?page_size=100")}
    flows = {
        "authz": flows_raw["default-provider-authorization-implicit-consent"],
        "inval": flows_raw["default-provider-invalidation-flow"],
        "authn": flows_raw.get("default-authentication-flow"),
    }
    scopes_map = {
        s["managed"]: s["pk"]
        for s in ak.list_results("/propertymappings/provider/scope/?page_size=100")
        if s.get("managed")
    }
    scopes = [
        scopes_map["goauthentik.io/providers/oauth2/scope-openid"],
        scopes_map["goauthentik.io/providers/oauth2/scope-email"],
        scopes_map["goauthentik.io/providers/oauth2/scope-profile"],
    ]
    certs = ak.list_results("/crypto/certificatekeypairs/?page_size=50")
    if not certs:
        raise SystemExit("no certificate keypair found")
    signing_key = certs[0]["pk"]

    result: dict = {"oauth2": {}, "proxy": {}, "apps": {}}

    result["oauth2"]["grafana"] = upsert_oauth2(
        ak,
        name="Grafana",
        slug="grafana",
        client_id="grafana",
        client_secret=grafana_secret,
        redirect_url="http://grafana.k3s.local/login/generic_oauth",
        launch_url="http://grafana.k3s.local",
        logout_uri="http://grafana.k3s.local/logout",
        flows=flows,
        scopes=scopes,
        signing_key=signing_key,
    )
    result["oauth2"]["minio"] = upsert_oauth2(
        ak,
        name="MinIO",
        slug="minio",
        client_id="minio",
        client_secret=minio_secret,
        redirect_url="http://minio.k3s.local/oauth_callback",
        launch_url="http://minio.k3s.local",
        logout_uri="http://minio.k3s.local",
        flows=flows,
        scopes=scopes,
        signing_key=signing_key,
    )

    proxy_pks: list[int] = []
    for name, slug, url in [
        ("Excalidraw", "excalidraw", "http://draw.k3s.local"),
        ("Tempo", "tempo", "http://tempo.k3s.local"),
        ("Loki", "loki", "http://loki.k3s.local"),
        ("EMQX Dashboard", "emqx", "http://emqx.k3s.local"),
    ]:
        app = upsert_proxy_app(
            ak,
            name=name,
            slug=slug,
            launch_url=url,
            authentik_public_url=public,
            cookie_domain=cookie_domain,
            flows=flows,
        )
        result["apps"][slug] = app
        proxy_pks.append(app["provider_pk"])

    result["outpost"] = assign_proxies_to_embedded_outpost(
        ak, proxy_pks, authentik_public_url=public
    )

    # Brand domain should match the Host users hit (avoids localhost detection).
    brands = ak.list_results("/core/brands/?page_size=20")
    for brand in brands:
        if brand.get("default"):
            ak.patch(
                f"/core/brands/{brand['brand_uuid']}/",
                {
                    "domain": "auth.k3s.local",
                    "branding_title": brand.get("branding_title") or "authentik",
                },
            )
            result["brand"] = {"domain": "auth.k3s.local", "pk": brand.get("brand_uuid")}
            break

    print(json.dumps(result, indent=2))


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] != "upsert":
        raise SystemExit(f"usage: {sys.argv[0]} upsert")
    ak = Authentik(env("AUTHENTIK_URL"), env("AUTHENTIK_TOKEN"))
    upsert(ak)


if __name__ == "__main__":
    main()
