import type { WorkerObservability } from "@alchemy.run/cloudflare/Workers/Worker";

export const WORKER_NAME = "egghead-stripe-ingress";
export const SECRET_NAMES = ["STRIPE_WEBHOOK_SECRET", "VERCEL_PROTECTION_BYPASS"] as const;

export interface DeployConfig {
  readonly accountId: string;
  readonly forwardUrl: string;
  readonly forwardNonce: string;
}

export interface WorkerProps {
  readonly upstreamUrl: string;
  readonly modules: Readonly<Record<string, string>>;
}

export interface WorkerAttributes {
  readonly accountId: string;
  readonly scriptName: string;
  readonly url: string;
}

// Wire names are snake_case; the Alchemy type also checks the shared disabled fields.
const disabledObservability = {
  enabled: false,
  logs: { enabled: false, invocationLogs: false },
  traces: { enabled: false },
} satisfies WorkerObservability;
export const OBSERVABILITY = {
  ...disabledObservability,
  logs: { enabled: false, invocation_logs: false },
};
const discard = (response: Response) => {
  void response.body?.cancel().catch(() => undefined);
};

export class CloudflareApiError extends Error {
  readonly _tag = "CloudflareApiError";
  constructor(readonly status: number) {
    // Deliberately omit upstream errors, headers, bodies and the forwarder nonce.
    super(`Scoped Cloudflare operation failed (${status})`);
  }
}

type Send = (url: string, init: RequestInit) => Promise<Response>;

export function cloudflareApi(config: DeployConfig, send: Send = fetch) {
  if (!/^[a-f0-9]{32}$/.test(config.accountId))
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character lowercase hex account ID");
  const base = new URL(config.forwardUrl);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.pathname !== "/" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("SC_FORWARD_URL must be a literal IPv4 loopback HTTP origin");
  }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(config.forwardNonce))
    throw new Error("SC_FORWARD_NONCE must be a per-run nonce of at least 32 URL-safe characters");
  const prefix = `/client/v4/accounts/${config.accountId}/workers`;
  const script = `${prefix}/scripts/${WORKER_NAME}`;
  // The production service-environment alias is the same script. Wrangler uses
  // this endpoint for service deployments; it stays under the named service grant.
  const subdomain = `${prefix}/services/${WORKER_NAME}/environments/production/subdomain`;
  // No account/script/domain/zone listing, settings, telemetry or state-store API.
  const allowed = new Set([
    `GET ${script}`,
    `PUT ${script}`,
    `DELETE ${script}`,
    `GET ${script}/secrets`,
    `POST ${subdomain}`,
    `GET ${prefix}/subdomain`,
  ]);
  const call = async (method: string, path: string, body?: BodyInit): Promise<Response> => {
    if (!allowed.has(`${method} ${path}`))
      throw new Error("Cloudflare API request outside ingress scope");
    try {
      return await send(`${base.origin}${path}`, {
        method,
        headers: {
          authorization: "Bearer {{secret:egghead-stripe-ingress/cloudflare}}",
          "x-sc-forward-token": config.forwardNonce,
          ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CloudflareApiError(502);
    }
  };
  const checked = async (response: Response) => {
    if (!response.ok) {
      discard(response);
      throw new CloudflareApiError(response.status);
    }
    return response;
  };
  const exists = async () => {
    const response = await call("GET", script);
    discard(response);
    if (response.status === 404) return false;
    if (!response.ok) throw new CloudflareApiError(response.status);
    return true;
  };
  const attributes = async (): Promise<WorkerAttributes> => {
    const response = await checked(await call("GET", `${prefix}/subdomain`));
    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("result" in data) ||
      typeof data.result !== "object" ||
      data.result === null ||
      !("subdomain" in data.result) ||
      typeof data.result.subdomain !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(data.result.subdomain)
    ) {
      throw new CloudflareApiError(502);
    }
    return {
      accountId: config.accountId,
      scriptName: WORKER_NAME,
      url: `https://${WORKER_NAME}.${data.result.subdomain}.workers.dev`,
    };
  };
  return {
    exists,
    attributes,
    async upload(props: WorkerProps): Promise<WorkerAttributes> {
      const form = new FormData();
      form.set(
        "metadata",
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: "2026-11-21",
          bindings: [{ type: "plain_text", name: "SHADOW_UPSTREAM_URL", text: props.upstreamUrl }],
          // Lockjaw owns secret provisioning and rotation. No secret values enter Alchemy.
          keep_bindings: ["secret_text"],
          logpush: false,
          observability: OBSERVABILITY,
          tail_consumers: [],
          streaming_tail_consumers: [],
        }),
      );
      for (const [name, source] of Object.entries(props.modules)) {
        if (name !== "worker.js" && name !== "handler.js")
          throw new Error("Unexpected Worker module");
        form.set(name, new Blob([source], { type: "application/javascript+module" }), name);
      }
      discard(await checked(await call("PUT", script, form)));
      discard(
        await checked(
          await call("POST", subdomain, JSON.stringify({ enabled: true, previews_enabled: false })),
        ),
      );
      return attributes();
    },
    async remove(): Promise<void> {
      const response = await call("DELETE", script);
      discard(response);
      if (!response.ok && response.status !== 404) throw new CloudflareApiError(response.status);
    },
  };
}
