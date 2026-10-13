import * as Effect from "effect/Effect";
import { connection } from "next/server";
import {
  getWorkshop,
  listUpcomingWorkshops,
  listWorkshopReferences,
} from "@egghead/workshops/capabilities";
import type { WorkshopCursor } from "@egghead/workshops/contracts";
import { workshopCatalogLayer } from "./catalog";

export async function getWorkshopBySlug(slug: string) {
  await connection();
  return Effect.runPromise(getWorkshop({ slug }).pipe(Effect.provide(workshopCatalogLayer)));
}
export async function getUpcomingWorkshops(after?: WorkshopCursor) {
  await connection();
  return Effect.runPromise(
    listUpcomingWorkshops(after ? { after } : {}).pipe(Effect.provide(workshopCatalogLayer)),
  );
}
export function getWorkshopReferences() {
  return Effect.runPromise(listWorkshopReferences().pipe(Effect.provide(workshopCatalogLayer)));
}
