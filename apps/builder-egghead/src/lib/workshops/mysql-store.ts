import { Effect, Layer, Schema } from "effect";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { PublishedWorkshop, Workshop, WorkshopFailure } from "@egghead/core/contracts";
import { WorkshopStore } from "@egghead/core/workshops";
import { assertBuilderDatabaseUrlForRuntime } from "@/db/runtime-guard";

type ResourceRow = RowDataPacket & {
  id: string;
  type: string;
  createdById: string;
  fields: unknown;
};

export function assertLocalWorkshopRuntime(databaseUrl: string) {
  const safety = assertBuilderDatabaseUrlForRuntime(databaseUrl);
  if (!safety.localDockerOnly || safety.runtime !== "local") {
    throw new Error("Native Workshop capabilities are local-only");
  }
}

/** This boundary uses native ContentResource storage without invoking commerce workflows. */
export function workshopStoreLayer(databaseUrl: string, tablePrefix: string) {
  return Layer.scoped(
    WorkshopStore,
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => {
          assertLocalWorkshopRuntime(databaseUrl);
          if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(tablePrefix)) throw new Error("Invalid table prefix");
        },
        catch: () =>
          new WorkshopFailure({
            code: "RuntimeBlocked",
            message: "Native Workshops require a local test database and valid table prefix",
          }),
      });
      const connection = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => mysql.createConnection(databaseUrl),
          catch: () =>
            new WorkshopFailure({
              code: "StoreUnavailable",
              message: "Workshop database connection failed",
            }),
        }),
        (connected) => Effect.promise(() => connected.end()),
      );
      const table = `\`${tablePrefix}_ContentResource\``;
      const dbEffect = <A>(operation: () => Promise<A>) =>
        Effect.tryPromise({
          try: operation,
          catch: (error) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ER_DUP_ENTRY"
            ) {
              return new WorkshopFailure({
                code: "Conflict",
                message: "Workshop requestId already exists; inspect the existing Workshop",
              });
            }
            return new WorkshopFailure({
              code: "StoreUnavailable",
              message: "Workshop database operation failed",
            });
          },
        });
      const decodeRow = (row: ResourceRow) =>
        Effect.gen(function* () {
          const fields = yield* Effect.try({
            try: (): unknown =>
              typeof row.fields === "string" ? JSON.parse(row.fields) : row.fields,
            catch: () =>
              new WorkshopFailure({
                code: "InvalidWorkshop",
                message: "Stored Workshop fields are invalid",
              }),
          });
          return yield* Schema.decodeUnknown(Workshop)({ ...row, fields }).pipe(
            Effect.mapError(
              () =>
                new WorkshopFailure({
                  code: "InvalidWorkshop",
                  message: "Stored Workshop does not match the native draft contract",
                }),
            ),
          );
        });
      const get = (id: string) =>
        Effect.gen(function* () {
          const [rows] = yield* dbEffect(() =>
            connection.execute<ResourceRow[]>(
              `SELECT id, type, createdById, fields FROM ${table} WHERE id = ? AND type = 'workshop' AND deletedAt IS NULL LIMIT 1`,
              [id],
            ),
          );
          return rows[0] ? yield* decodeRow(rows[0]) : null;
        });
      const requireWorkshop = (id: string) =>
        Effect.gen(function* () {
          const result = yield* get(id);
          if (!result)
            return yield* Effect.fail(
              new WorkshopFailure({ code: "NotFound", message: "Workshop not found" }),
            );
          return result;
        });
      const revise = (
        workshop: Workshop,
        expectedRevision: number,
        expectedState = workshop.fields.state,
      ) =>
        Effect.gen(function* () {
          const encoded = yield* Schema.encode(Workshop)(workshop).pipe(
            Effect.mapError(
              () =>
                new WorkshopFailure({
                  code: "InvalidWorkshop",
                  message: "Invalid Workshop write",
                }),
            ),
          );
          const mergedFields =
            "JSON_REMOVE(JSON_MERGE_PATCH(fields, CAST(? AS JSON)), '$.landingPage')";
          const fieldsExpression = encoded.fields.landingPage
            ? `JSON_SET(${mergedFields}, '$.landingPage', CAST(? AS JSON))`
            : mergedFields;
          const parameters = [JSON.stringify(encoded.fields)];
          if (encoded.fields.landingPage)
            parameters.push(JSON.stringify(encoded.fields.landingPage));
          const [result] = yield* dbEffect(() =>
            connection.execute<mysql.ResultSetHeader>(
              `UPDATE ${table} SET fields = ${fieldsExpression}, updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ? AND type = 'workshop' AND deletedAt IS NULL AND createdById = ? AND JSON_EXTRACT(fields, '$.workshopRevision') = ? AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.state')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.visibility')) = ?`,
              [
                ...parameters,
                encoded.id,
                encoded.createdById,
                expectedRevision,
                expectedState,
                expectedState === "draft" ? "unlisted" : "public",
              ],
            ),
          );
          if (result.affectedRows !== 1)
            return yield* Effect.fail(
              new WorkshopFailure({
                code: "Conflict",
                message: "Workshop changed; inspect and preview it again",
              }),
            );
          return yield* requireWorkshop(workshop.id);
        });
      return WorkshopStore.of({
        get,
        list: ({ limit, cursor, ownerId }) =>
          Effect.gen(function* () {
            const parameters: (string | number)[] = [];
            let filters =
              "type = 'workshop' AND deletedAt IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.state')) IN ('draft', 'published')";
            if (ownerId) {
              filters += " AND createdById = ?";
              parameters.push(ownerId);
            }
            if (cursor) {
              filters += " AND id > ?";
              parameters.push(cursor);
            }
            // Limit is decoded to an integer in [1, 50] by the capability contract.
            const [rows] = yield* dbEffect(() =>
              connection.execute<ResourceRow[]>(
                `SELECT id, type, createdById, fields FROM ${table} WHERE ${filters} ORDER BY id ASC LIMIT ${limit + 1}`,
                parameters,
              ),
            );
            const page = rows.slice(0, limit);
            const workshops = yield* Effect.forEach(page, decodeRow);
            return {
              workshops,
              nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
            };
          }),
        create: (workshop) =>
          Effect.gen(function* () {
            const encoded = yield* Schema.encode(Workshop)(workshop).pipe(
              Effect.mapError(
                () =>
                  new WorkshopFailure({
                    code: "InvalidWorkshop",
                    message: "Invalid Workshop write",
                  }),
              ),
            );
            const existing = yield* get(workshop.id);
            if (existing)
              return yield* Effect.fail(
                new WorkshopFailure({
                  code: "Conflict",
                  message: "Workshop requestId already exists; inspect the existing Workshop",
                }),
              );
            yield* dbEffect(() =>
              connection.execute(
                `INSERT INTO ${table} (id, type, createdById, fields) VALUES (?, 'workshop', ?, ?)`,
                [encoded.id, encoded.createdById, JSON.stringify(encoded.fields)],
              ),
            );
            return yield* requireWorkshop(workshop.id);
          }),
        revise,
        canPublish: ({ workshopId, productId, priceId }) =>
          Effect.gen(function* () {
            const [rows] = yield* dbEffect(() =>
              connection.execute<ResourceRow[]>(
                `SELECT p.id FROM \`${tablePrefix}_Product\` p
             JOIN \`${tablePrefix}_ContentResourceProduct\` link ON link.productId = p.id AND link.resourceId = ?
             JOIN \`${tablePrefix}_Price\` price ON price.productId = p.id AND price.id = ?
             WHERE p.id = ? AND link.deletedAt IS NULL AND p.status = 1 AND p.type = 'live' AND p.quantityAvailable = -1
             AND JSON_UNQUOTE(JSON_EXTRACT(p.fields, '$.state')) = 'published'
             AND price.status = 1 AND price.unitAmount > 0
             AND JSON_UNQUOTE(JSON_EXTRACT(price.fields, '$.stripe.type')) = 'one_time'
             AND JSON_UNQUOTE(JSON_EXTRACT(price.fields, '$.stripe.currency')) = 'usd'
             AND JSON_UNQUOTE(JSON_EXTRACT(price.fields, '$.stripe.active')) = 'true'
             AND JSON_UNQUOTE(JSON_EXTRACT(price.fields, '$.stripe.supported')) = 'true'
             AND JSON_UNQUOTE(JSON_EXTRACT(price.fields, '$.offer.offered')) = 'true' LIMIT 1`,
                [workshopId, priceId, productId],
              ),
            );
            return rows.length === 1;
          }),
        publish: (workshop, expectedRevision) =>
          Effect.gen(function* () {
            const saved = yield* revise(workshop, expectedRevision, "draft");
            return yield* Schema.decodeUnknown(PublishedWorkshop)(saved).pipe(
              Effect.mapError(
                () =>
                  new WorkshopFailure({
                    code: "InvalidWorkshop",
                    message: "Invalid published Workshop",
                  }),
              ),
            );
          }),
      });
    }),
  );
}
