import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  cloudflareApi,
  CloudflareApiError,
  WORKER_NAME,
  type DeployConfig,
  type WorkerAttributes,
  type WorkerProps,
} from "./cloudflare-api.js";

export type StripeIngress = Resource<"Egghead.StripeIngress", WorkerProps, WorkerAttributes>;
export const StripeIngress = Resource<StripeIngress>("Egghead.StripeIngress");

// Lifecycle: absent -> upload -> publish workers.dev -> locally recorded.
// Read without a local receipt reports foreign ownership. Failed writes propagate;
// Alchemy must not save a successful receipt or retry an uncertain write here.
export function ingressLifecycle(config: DeployConfig, api = cloudflareApi(config)) {
  const checkReceipt = (output: WorkerAttributes | undefined) => {
    if (output && (output.accountId !== config.accountId || output.scriptName !== WORKER_NAME)) {
      throw new CloudflareApiError(409);
    }
  };
  return {
    async read(output: WorkerAttributes | undefined) {
      checkReceipt(output);
      if (!(await api.exists())) return undefined;
      const observed = await api.attributes();
      return output ? observed : Unowned(observed);
    },
    async reconcile(props: WorkerProps) {
      return api.upload(props);
    },
    async remove(output: WorkerAttributes) {
      checkReceipt(output);
      await api.remove();
    },
  };
}

const operation = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof CloudflareApiError ? error : new CloudflareApiError(502)),
  });

export function ingressProvider(config: DeployConfig) {
  const lifecycle = ingressLifecycle(config);
  return Provider.succeed(StripeIngress, {
    stables: ["accountId", "scriptName", "url"],
    read: ({ output }) => operation(() => lifecycle.read(output)),
    reconcile: ({ news }) => operation(() => lifecycle.reconcile(news)),
    delete: ({ output }) => operation(() => lifecycle.remove(output)),
    // No list, lookup, logs or tail: none is needed for this named resource.
  });
}
