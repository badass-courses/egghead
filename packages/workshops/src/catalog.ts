import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  CatalogUnavailable,
  InvalidWorkshopData,
  WorkshopCursor,
  WorkshopReference,
  WorkshopSnapshot,
} from "./contracts";

export type CatalogError = CatalogUnavailable | InvalidWorkshopData;
export type SnapshotPage = { workshops: readonly WorkshopSnapshot[]; next: WorkshopCursor | null };
export type ReferencePage = { workshops: readonly WorkshopReference[]; next: string | null };
export type UpcomingQuery = { now: string; limit: number; after: WorkshopCursor | null };
export class WorkshopCatalog extends Context.Service<
  WorkshopCatalog,
  {
    get(slug: string): Effect.Effect<WorkshopSnapshot | null, CatalogError>;
    listUpcoming(query: UpcomingQuery): Effect.Effect<SnapshotPage, CatalogError>;
    listDiscoverable(after: string | null): Effect.Effect<ReferencePage, CatalogError>;
  }
>()("@egghead/workshops/WorkshopCatalog") {}
