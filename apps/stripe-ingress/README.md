# Stripe shadow ingress

A Worker for `POST /api/stripe/subscription-shadow`. It verifies Stripe's signature before forwarding to the fixed beta shadow route behind Vercel Deployment Protection. It does not write subscriptions or change ownership.

## Request contract

- Only the exact POST path is accepted. Other paths return 404; other methods, including OPTIONS, return 405. There is no CORS handler.
- Declared and streamed bodies are capped at 256 KiB. The Worker keeps the original bytes in an ArrayBuffer, including whitespace and non-ASCII content.
- WebCrypto verifies HMAC-SHA256 over the Stripe timestamp, a dot, and those bytes. One timestamp and one or more `v1` signatures are accepted. Comparison covers every digest byte. Timestamp tolerance is five minutes in either direction.
- Upstream comes only from `SHADOW_UPSTREAM_URL`. The stack requires `https://beta.egghead.io/api/stripe/subscription-shadow`, with no alternate host or port, credentials, query or fragment, so deployment cannot redirect the bypass secret to another host. Client path, query and Host never select the destination.
- Forwarded headers are exactly `content-type: application/json`, the verified `stripe-signature`, and the secret `x-vercel-protection-bypass`. Client cookies, authorization and Vercel headers are discarded.
- One fetch, a ten-second timeout, and no internal retry. Upstream redirects and fetch failures return 502 so Stripe can retry. Other upstream statuses are preserved with a fixed short body (no body for 204/205). Upstream bodies and headers are never relayed.
- The Worker never logs request data or exceptions. Upload metadata disables Workers Logs, invocation logs, traces, logpush, tail consumers and streaming tail consumers.

## Deployment contract

**Do not deploy until Bastion reviews and the owner authorizes deployment.** This change creates no Cloudflare, Vercel or Stripe resources.

| Item                 | Configuration                                                                     |
| -------------------- | --------------------------------------------------------------------------------- |
| Script and service   | Exactly `egghead-stripe-ingress`                                                  |
| Hostname             | `egghead-stripe-ingress.<fleet-account-subdomain>.workers.dev`                    |
| Zone / custom domain | None                                                                              |
| Account              | Fleet account, selected through deploy-time `CLOUDFLARE_ACCOUNT_ID`               |
| Upstream             | Deploy-time `SHADOW_UPSTREAM_URL`, persisted as a plain Worker binding            |
| Worker secrets       | `STRIPE_WEBHOOK_SECRET`, `VERCEL_PROTECTION_BYPASS`                               |
| Cloudflare auth      | Lockjaw cell credential `egghead-stripe-ingress/cloudflare`, through `sc forward` |
| Local forwarder      | `SC_FORWARD_URL`, a literal `http://127.0.0.1:<port>` origin                      |
| Forwarder protection | `SC_FORWARD_NONCE`, a per-run random nonce shared with `sc forward`               |
| State                | Local `apps/stripe-ingress/.alchemy/state/`, ignored by Git                       |

There is no Alchemy Cloudflare profile, raw Cloudflare token in env, Cloudflare state-store Worker, zone lookup, or account lookup. The provider sends only a credential placeholder to the loopback forwarder. Lockjaw resolves the real token in the cell. Redirects from the API are not followed.

Lockjaw owns the two Worker secret values and their rotation. The stack names their runtime bindings but never reads or stores values. Script uploads use `keep_bindings: ["secret_text"]` to preserve externally provisioned secrets. Initial deployment can create a Worker without secrets; it returns 503 until Lockjaw installs both. Do not enable the Stripe destination until the secrets and an end-to-end signed POST have been verified. Use the same Stripe webhook signing secret expected by the upstream shadow route.

### Scoped Cloudflare API

`infra/cloudflare-api.ts` has an exact method/path allowlist. With `{account}` supplied at deploy time, it calls only:

```text
GET    /client/v4/accounts/{account}/workers/scripts/egghead-stripe-ingress
PUT    /client/v4/accounts/{account}/workers/scripts/egghead-stripe-ingress
DELETE /client/v4/accounts/{account}/workers/scripts/egghead-stripe-ingress
POST   /client/v4/accounts/{account}/workers/services/egghead-stripe-ingress/environments/production/subdomain
GET    /client/v4/accounts/{account}/workers/subdomain
```

The same-script secrets GET is allowed at the boundary but unused. The stack does not need `tokens/verify` or any other Cloudflare endpoint. The named service's production-environment subdomain endpoint enables the stable workers.dev hostname and disables previews. This is the service API path used by [Wrangler 4.45.0](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.45.0/packages/wrangler/src/triggers/deploy.ts). It remains under the same-named service grant; it does not require a script-wide or account-wide listing permission.

### Replaced Alchemy calls

The stack uses Alchemy v2's Effect stack, resource lifecycle and local state, but does **not** install the standard Cloudflare providers. Its small `Egghead.StripeIngress` provider replaces these beta.87 behaviors:

| Standard Worker provider                                                           | This app                                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `read`/`lookup` can fall back to `workers.listScripts` to discover an immutable ID | GET the one named script; use its fixed name and local receipt. No lookup or enumeration.                            |
| `delete` attempts `workers.listDomains`, even without a custom domain              | DELETE the one named script, treating 404 as already deleted.                                                        |
| Profile-backed account/auth resolution                                             | Deploy-time account ID and cell placeholder through the local forwarder.                                             |
| Cloudflare-backed state                                                            | `alchemy/State/LocalState` only.                                                                                     |
| Bundler and general Worker resource reconciliation                                 | TypeScript transpiles the two runtime modules; a multipart script PUT uploads only those modules and fixed metadata. |
| Script subdomain endpoint                                                          | The same-named service's production subdomain endpoint.                                                              |
| Secret values in resource props                                                    | Externally provisioned secret_text bindings preserved by name/type.                                                  |

A live script without a local receipt is reported as foreign, not silently adopted. Keep the state directory on one deployment runner, serialize deployments, and back it up before changes. Do not use another stage or `--adopt` to bypass a missing receipt: every stage targets the same script. If an upload succeeds but local state is lost or publishing fails, inspect the named script before an owner-approved recovery. Local-state custody is required for safe update and destroy.

Plan checks existence, not remote source or metadata drift. The documented deploy command uses `--force` to reassert the code and disabled logging settings. No provider operation retries an uncertain write.

### Commands for an authorized deploy operator

Run from the repository root with an enrolled `sc` identity that can use the cell credential. Supply the approved account ID and fixed beta URL; do not put secrets or `.env` files in Git.

Start a forwarder in the same shell, keep its PID, and stop only that process when finished:

```sh
export CLOUDFLARE_ACCOUNT_ID='<approved-fleet-account-id>'
export SHADOW_UPSTREAM_URL='https://beta.egghead.io/api/stripe/subscription-shadow'
export SC_FORWARD_URL='http://127.0.0.1:8789'
export SC_FORWARD_NONCE="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
sc forward --listen 127.0.0.1:8789 --upstream-host api.cloudflare.com &
forward_pid=$!
trap 'kill "$forward_pid"; wait "$forward_pid" 2>/dev/null || true' EXIT
```

Wait for `sc forward` to report its listener ready before running any command. The provider refuses a non-loopback origin and requires the nonce. The nonce is not the Cloudflare token.

```sh
# Plan (read-only against Cloudflare; writes local plan/log files)
mise exec node@24 pnpm@11.3.0 -- pnpm --filter @egghead/stripe-ingress plan --stage beta --no-input

# Deploy, only after approval; reassert fixed code and disabled logging
mise exec node@24 pnpm@11.3.0 -- pnpm --filter @egghead/stripe-ingress deploy --stage beta --force --yes --no-input

# Destroy, only after separate approval, using the same runner/state/stage
mise exec node@24 pnpm@11.3.0 -- pnpm --filter @egghead/stripe-ingress destroy --stage beta --yes --no-input
```

Use the URL emitted by the stack after deployment. Do not guess the account subdomain. Roll back by deploying the previously reviewed commit from the same runner with the same state and config; retain both Worker secrets. Do not use a failed upstream response as a reason to widen the API or bypass scope.

## Verification

```sh
pnpm stripe:ingress:test
pnpm check
```

Tests use synthetic secrets, a fixed clock and local API mocks. They cover the request rules, the provider allowlist, metadata and secret preservation, account/receipt guards, and a real Alchemy CLI cycle (plan, mock apply, re-plan, mock update, mock destroy) against a temporary loopback server. No test uses Cloudflare, Vercel or Stripe credentials or creates remote resources. They also scan local state for the synthetic nonce and credential placeholder.

Dependencies are exact app-only pins: Alchemy and Cloudflare beta.87, Effect 4.1.4, and the required CLI peer `@effect/platform-node` 4.1.4. Existing pins stay unchanged: root and web use Effect 4.0.0; builder uses 3.11.5. The app adds `DOM.AsyncIterable` types for bounded streaming reads without weakening the shared TypeScript config.
