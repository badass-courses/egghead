import { Context, Effect, JSONSchema, Schema } from "effect";

export class CapabilityFailure extends Schema.TaggedError<CapabilityFailure>()(
  "CapabilityFailure",
  {
    code: Schema.Literal("InvalidInput", "InvalidOutput", "ApprovalDenied"),
    message: Schema.String,
  },
) {}

export class Approval extends Context.Tag("egghead/Approval")<
  Approval,
  { readonly require: (name: string) => Effect.Effect<void, CapabilityFailure> }
>() {}

export function defineContract<I, O, E, EI>(
  name: string,
  options: {
    readonly description: string;
    readonly input: Schema.Schema<I>;
    readonly output: Schema.Schema<O>;
    readonly failure: Schema.Schema<E, EI>;
    readonly needsApproval: boolean;
    readonly annotations: {
      readonly readOnly: boolean;
      readonly idempotent: boolean;
      readonly destructive: boolean;
      readonly openWorld: boolean;
    };
  },
) {
  return { name, ...options };
}

export function implement<I, O, E, EI, R>(
  contract: ReturnType<typeof defineContract<I, O, E, EI>>,
  handler: (input: I) => Effect.Effect<O, E, R>,
) {
  return {
    contract,
    inputJsonSchema: JSONSchema.make(contract.input),
    outputJsonSchema: JSONSchema.make(contract.output),
    run: (rawInput: unknown) =>
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknown(contract.input)(rawInput, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(
            () =>
              new CapabilityFailure({ code: "InvalidInput", message: "Invalid capability input" }),
          ),
        );
        if (contract.needsApproval) {
          const approval = yield* Approval;
          yield* approval.require(contract.name);
        }
        const result = yield* handler(input);
        return yield* Schema.decodeUnknown(contract.output)(result).pipe(
          Effect.mapError(
            () =>
              new CapabilityFailure({
                code: "InvalidOutput",
                message: "Invalid capability result",
              }),
          ),
        );
      }),
  };
}
