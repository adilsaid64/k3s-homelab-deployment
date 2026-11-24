#!/usr/bin/env python3
"""Configure Authentik SSO for apps with native OIDC (Grafana only).

Env:
  AUTHENTIK_URL, AUTHENTIK_TOKEN (required)
  GRAFANA_CLIENT_SECRET (required)
  AUTHENTIK_PUBLIC_URL   default http://auth.k3s.local
"""

from __future__ import annotations

import json
import os
import sys
import time
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

    def request(self, method: str, path: str, body: dict | None = None) -> dict | None:
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
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise SystemExit(f"{method} {path} -> {exc.code}: {detail}") from exc

    def get(self, path: str) -> dict | None:
        return self.request("GET", path)

    def post(self, path: str, body: dict) -> dict:
        out = self.request("POST", path, body)
        assert out is not None
        return out

    def patch(self, path: str, body: dict) -> dict:
        out = self.request("PATCH", path, body)
        assert out is not None
        return out

    def delete(self, path: str) -> None:
        self.request("DELETE", path)

    def list_results(self, path: str) -> list[dict]:
        out: list[dict] = []
        next_path: str | None = path
        while next_path:
            page = self.get(next_path)
            assert page is not None
            out.extend(page.get("results") or [])
            nxt = page.get("pagination", {}).get("next")
            if not nxt:
                break
            if nxt.startswith("http"):
                parsed = urllib.parse.urlparse(nxt)
                next_path = parsed.path.replace("/api/v3", "", 1) + (
                    f"?{parsed.query}" if parsed.query else ""
                )
                if not next_path.startswith("/"):
                    next_path = "/" + next_path
            else:
                next_path = nxt
        return out


def find_by(items: list[dict], key: str, value: str) -> dict | None:
    for item in items:
        if item.get(key) == value:
            return item
    return None


def wait_for_flows(ak: Authentik, required: list[str], attempts: int = 30, delay_s: float = 2.0) -> dict[str, str]:
    """Bootstrap can finish before default flows exist — retry briefly."""
    last: dict[str, str] = {}
    for _ in range(attempts):
        last = {f["slug"]: f["pk"] for f in ak.list_results("/flows/instances/?page_size=100")}
        if all(slug in last for slug in required):
            return last
        time.sleep(delay_s)
    missing = [s for s in required if s not in last]
    raise SystemExit(f"authentik flows not ready, missing: {missing}")


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


def remove_forward_auth(ak: Authentik, *, authentik_public_url: str) -> dict:
    """Drop proxy/forward-auth apps left from earlier homelab SSO experiments."""
    removed_apps: list[str] = []
    removed_providers: list[int] = []

    # Clear embedded outpost so domain forward-auth stops matching *.k3s.local
    outposts = ak.list_results("/outposts/instances/?page_size=50")
    embedded = find_by(outposts, "name", "authentik Embedded Outpost") or (
        outposts[0] if outposts else None
    )
    if embedded:
        config = dict(embedded.get("config") or {})
        config["authentik_host"] = authentik_public_url
        config["authentik_host_browser"] = authentik_public_url
        config["authentik_host_insecure"] = True
        ak.patch(
            f"/outposts/instances/{embedded['pk']}/",
            {"providers": [], "config": config},
        )

    forward_slugs = {"minio", "excalidraw", "tempo", "loki", "emqx"}
    for app in ak.list_results("/core/applications/?page_size=100"):
        slug = app.get("slug")
        if slug in forward_slugs:
            ak.delete(f"/core/applications/{slug}/")
            removed_apps.append(slug)

    for provider in ak.list_results("/providers/proxy/?page_size=100"):
        pk = provider["pk"]
        ak.delete(f"/providers/proxy/{pk}/")
        removed_providers.append(pk)

    # Old MinIO OIDC provider (Console no longer supports it)
    for provider in ak.list_results("/providers/oauth2/?page_size=100"):
        if provider.get("client_id") == "minio":
            # Unbind app first if still present
            for app in ak.list_results("/core/applications/?page_size=100"):
                if app.get("provider") == provider["pk"]:
                    ak.delete(f"/core/applications/{app['slug']}/")
                    removed_apps.append(app["slug"])
            ak.delete(f"/providers/oauth2/{provider['pk']}/")
            removed_providers.append(provider["pk"])

    return {"apps": removed_apps, "providers": removed_providers}


def upsert(ak: Authentik) -> None:
    public = env("AUTHENTIK_PUBLIC_URL", "http://auth.k3s.local").rstrip("/")
    grafana_secret = env("GRAFANA_CLIENT_SECRET")

    flows_raw = wait_for_flows(
        ak,
        [
            "default-provider-authorization-implicit-consent",
            "default-provider-invalidation-flow",
        ],
    )
    flows = {
        "authz": flows_raw["default-provider-authorization-implicit-consent"],
        "inval": flows_raw["default-provider-invalidation-flow"],
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

    result: dict = {
        "removed_forward_auth": remove_forward_auth(ak, authentik_public_url=public),
        "oauth2": {},
    }

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
