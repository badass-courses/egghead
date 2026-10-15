import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkshopCatalog, type UpcomingQuery } from "./catalog";
import type { WorkshopSnapshot } from "./contracts";
import { workshopStatus } from "./policy";

export function memoryWorkshopCatalog(snapshots: readonly WorkshopSnapshot[]) {
  return Layer.succeed(WorkshopCatalog, {
    get: (slug: string) =>
      Effect.succeed(snapshots.find((snapshot) => snapshot.slug === slug) ?? null),
    listUpcoming: (query: UpcomingQuery) =>
      Effect.sync(() => {
        const rows = snapshots
          .filter((snapshot) => {
            const status = workshopStatus(snapshot.startsAt, snapshot.endsAt, new Date(query.now));
            return (
              snapshot.visibility === "public" &&
              (status === "upcoming" || status === "in-progress") &&
              (!query.after ||
                (snapshot.startsAt ?? "") > query.after.startsAt ||
                (snapshot.startsAt === query.after.startsAt && snapshot.id > query.after.id))
            );
          })
          .toSorted(
            (a, b) =>
              (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || a.id.localeCompare(b.id),
          );
        const workshops = rows.slice(0, query.limit);
        const last = workshops.at(-1);
        return {
          workshops,
          next:
            rows.length > query.limit && last?.startsAt
              ? { startsAt: last.startsAt, id: last.id }
              : null,
        };
      }),
    listDiscoverable: (after: string | null) =>
      Effect.sync(() => {
        const rows = snapshots
          .filter((snapshot) => snapshot.visibility === "public" && (!after || snapshot.id > after))
          .toSorted((a, b) => a.id.localeCompare(b.id));
        const workshops = rows
          .slice(0, 100)
          .map(({ id, slug, updatedAt }) => ({ id, slug, updatedAt }));
        return { workshops, next: rows.length > 100 ? (workshops.at(-1)?.id ?? null) : null };
      }),
  });
}
