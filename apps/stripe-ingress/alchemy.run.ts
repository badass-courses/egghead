import { readFile } from "node:fs/promises";
import * as Alchemy from "alchemy";
import { localState } from "alchemy/State/LocalState";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ts from "typescript";
import { ingressProvider, StripeIngress } from "./infra/provider.js";
import { SHADOW_PATH } from "./src/handler.js";

const providers = Layer.unwrap(
  Effect.gen(function* () {
    return ingressProvider({
      accountId: yield* Config.String("CLOUDFLARE_ACCOUNT_ID"),
      forwardUrl: yield* Config.String("SC_FORWARD_URL"),
      forwardNonce: yield* Config.String("SC_FORWARD_NONCE"),
    });
  }).pipe(Effect.orDie),
);

// No Cloudflare providers/auth profile/state-store Worker: only our named resource.
export default Alchemy.Stack(
  "egghead-stripe-ingress",
  {
    providers,
    state: localState(),
  },
  Effect.gen(function* () {
    const upstreamUrl = yield* Config.String("SHADOW_UPSTREAM_URL");
    const upstream = new URL(upstreamUrl);
    if (
      upstream.protocol !== "https:" ||
      upstream.host !== "beta.egghead.io" ||
      upstream.pathname !== SHADOW_PATH ||
      upstream.username ||
      upstream.password ||
      upstream.search ||
      upstream.hash
    ) {
      return yield* Effect.die(
        new Error(
          "SHADOW_UPSTREAM_URL must be https://beta.egghead.io/api/stripe/subscription-shadow without credentials, query or fragment",
        ),
      );
    }
    const modules = yield* Effect.promise(async () =>
      Object.fromEntries(
        await Promise.all(
          ["handler", "worker"].map(async (name) => {
            const source = await readFile(new URL(`./src/${name}.ts`, import.meta.url), "utf8");
            const compiled = ts.transpileModule(source, {
              compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2023,
                sourceMap: false,
              },
            });
            return [`${name}.js`, compiled.outputText];
          }),
        ),
      ),
    );
    const worker = yield* StripeIngress("Ingress", { upstreamUrl, modules });
    return { url: worker.url };
  }),
);
