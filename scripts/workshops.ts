import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { getWorkshop, listUpcomingWorkshops } from "@egghead/workshops/capabilities";
import {
  getWorkshopContract,
  listUpcomingWorkshopsContract,
  InvalidWorkshopInput,
} from "@egghead/workshops/contracts";
import { workshopCatalogLayer } from "../apps/web/src/workshops/event-catalog";

const [command = "list", input = "{}"] = process.argv.slice(2);
const program =
  command === "get"
    ? Schema.decodeUnknownEffect(Schema.fromJsonString(getWorkshopContract.input))(input).pipe(
        Effect.mapError(() => new InvalidWorkshopInput({ capability: getWorkshopContract.name })),
        Effect.flatMap(getWorkshop),
      )
    : command === "list"
      ? Schema.decodeUnknownEffect(Schema.fromJsonString(listUpcomingWorkshopsContract.input))(
          input,
        ).pipe(
          Effect.mapError(
            () => new InvalidWorkshopInput({ capability: listUpcomingWorkshopsContract.name }),
          ),
          Effect.flatMap(listUpcomingWorkshops),
        )
      : Effect.die(new Error("Usage: pnpm workshops get '{\"slug\":\"example\"}' | list '{}'"));
const result = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* program;
  }).pipe(Effect.provide(workshopCatalogLayer)),
);
console.log(JSON.stringify(result, null, 2));
