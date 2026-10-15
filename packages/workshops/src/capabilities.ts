import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkshopCatalog, type ReferencePage } from "./catalog";
import {
  getWorkshopContract,
  listUpcomingWorkshopsContract,
  type ListUpcomingInput,
  type GetWorkshopInput,
  InvalidWorkshopInput,
  InvalidWorkshopData,
} from "./contracts";
import { evaluateWorkshop } from "./policy";

export const getWorkshop = Effect.fn("getWorkshop")(function* (input: GetWorkshopInput) {
  const parsed = yield* Schema.decodeUnknownEffect(getWorkshopContract.input)(input).pipe(
    Effect.mapError(() => new InvalidWorkshopInput({ capability: getWorkshopContract.name })),
  );
  const catalog = yield* WorkshopCatalog;
  const snapshot = yield* catalog.get(parsed.slug);
  const now = yield* DateTime.now;
  return yield* Schema.decodeUnknownEffect(getWorkshopContract.output)(
    snapshot ? evaluateWorkshop(snapshot, new Date(DateTime.toEpochMillis(now))) : null,
  ).pipe(Effect.mapError(() => new InvalidWorkshopData({ operation: "get workshop output" })));
});
export const listUpcomingWorkshops = Effect.fn("listUpcomingWorkshops")(function* (
  input: ListUpcomingInput,
) {
  const parsed = yield* Schema.decodeUnknownEffect(listUpcomingWorkshopsContract.input)(input).pipe(
    Effect.mapError(
      () => new InvalidWorkshopInput({ capability: listUpcomingWorkshopsContract.name }),
    ),
  );
  const catalog = yield* WorkshopCatalog;
  const now = yield* DateTime.now;
  const page = yield* catalog.listUpcoming({
    now: DateTime.formatIso(now),
    limit: parsed.limit ?? 100,
    after: parsed.after ?? null,
  });
  return yield* Schema.decodeUnknownEffect(listUpcomingWorkshopsContract.output)({
    ...page,
    workshops: page.workshops.map((snapshot) =>
      evaluateWorkshop(snapshot, new Date(DateTime.toEpochMillis(now))),
    ),
  }).pipe(Effect.mapError(() => new InvalidWorkshopData({ operation: "list workshop output" })));
});
export const capabilities = [
  { contract: getWorkshopContract, handler: getWorkshop },
  { contract: listUpcomingWorkshopsContract, handler: listUpcomingWorkshops },
] as const;

export const listWorkshopReferences = Effect.fn("listWorkshopReferences")(function* () {
  const catalog = yield* WorkshopCatalog;
  const references = [];
  let after: string | null = null;
  do {
    const page: ReferencePage = yield* catalog.listDiscoverable(after);
    references.push(...page.workshops);
    after = page.next;
  } while (after !== null);
  return references;
});
