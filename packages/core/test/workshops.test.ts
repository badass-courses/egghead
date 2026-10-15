import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Approval, CapabilityFailure } from "../src/capability";
import { Workshop, WorkshopFailure } from "../src/contracts";
import {
  capabilities,
  createWorkshop,
  getWorkshop,
  listWorkshops,
  previewCreateWorkshop,
  previewUpdateWorkshop,
  updateWorkshop,
  WorkshopActor,
  WorkshopStore,
} from "../src/workshops";

const input = {
  requestId: "b9646c65-7bf2-480f-a832-d6c0722a8308",
  title: "Build a native Workshop",
  description: "",
  startsAt: "2026-11-02T09:00:00-07:00",
  endsAt: "2026-11-02T12:00:00-07:00",
  timezone: "America/Denver",
  attendeeInstructions: "",
};

function fixture({ approved = true, owner = "instructor", canCreate = true } = {}) {
  const rows = new Map<string, Workshop>();
  let writes = 0;
  const services = Layer.mergeAll(
    Layer.succeed(WorkshopActor, {
      id: owner,
      canCreate,
      canManageAll: false,
      canManage: (workshop) => workshop.createdById === owner,
    }),
    Layer.succeed(Approval, {
      require: () =>
        approved
          ? Effect.void
          : Effect.fail(
              new CapabilityFailure({ code: "ApprovalDenied", message: "Approval required" }),
            ),
    }),
    Layer.succeed(WorkshopStore, {
      get: (id) => Effect.succeed(rows.get(id) ?? null),
      list: ({ limit, cursor, ownerId }) => {
        const matching = [...rows.values()]
          .filter(
            (row) => (!ownerId || row.createdById === ownerId) && (!cursor || row.id > cursor),
          )
          .toSorted((a, b) => a.id.localeCompare(b.id));
        const page = matching.slice(0, limit);
        return Effect.succeed({
          workshops: page,
          nextCursor: matching.length > limit ? (page.at(-1)?.id ?? null) : null,
        });
      },
      create: (workshop) =>
        Effect.suspend(() => {
          if (rows.has(workshop.id))
            return Effect.fail(
              new WorkshopFailure({ code: "Conflict", message: "Duplicate request" }),
            );
          writes++;
          rows.set(workshop.id, workshop);
          return Effect.succeed(workshop);
        }),
      revise: (workshop, expectedRevision) =>
        Effect.suspend(() => {
          if (rows.get(workshop.id)?.fields.workshopRevision !== expectedRevision)
            return Effect.fail(new WorkshopFailure({ code: "Conflict", message: "Stale edit" }));
          writes++;
          rows.set(workshop.id, workshop);
          return Effect.succeed(workshop);
        }),
    }),
  );
  return { rows, services, writes: () => writes };
}

describe("Workshop capability behavior", () => {
  it.effect(
    "landing-page copy survives creation and revision, with invalid content rejected",
    () => {
      const test = fixture();
      const landingPage = {
        bannerText: "BUILD SOFTWARE",
        headline: "Build a workflow you can repeat.",
        introduction: "A day of practical development.",
        instructor: {
          name: "Local Instructor",
          role: "Developer",
          biography: "Learn by building.",
        },
        sections: [
          { heading: "Start with a task", body: "Work through a real example.", bullets: [] },
        ],
        takeaways: ["A repeatable workflow."],
        questions: [],
      };
      return Effect.gen(function* () {
        const created = yield* createWorkshop.run({ ...input, landingPage });
        expect(created.fields.landingPage?.headline).toBe("Build a workflow you can repeat.");
        const revised = yield* updateWorkshop.run({
          id: created.id,
          expectedRevision: 1,
          changes: {
            landingPage: { ...landingPage, headline: "Keep building on what you learn." },
          },
        });
        expect(revised.fields.landingPage?.headline).toBe("Keep building on what you learn.");
        expect(revised.fields.landingPage?.instructor.name).toBe("Local Instructor");
        expect(revised.fields.startsAt).toBe("2026-11-02T16:00:00.000Z");
        const failure = yield* Effect.flip(
          updateWorkshop.run({
            id: created.id,
            expectedRevision: 2,
            changes: { landingPage: { ...landingPage, sections: [] } },
          }),
        );
        expect(failure.code).toBe("InvalidInput");
        expect(test.writes()).toBe(2);
      }).pipe(Effect.provide(test.services));
    },
  );

  it.effect("preview performs no writes and confirmed creation returns native draft fields", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const preview = yield* previewCreateWorkshop.run(input);
      expect(preview.fields.state).toBe("draft");
      expect(test.writes()).toBe(0);
      const workshop = yield* createWorkshop.run(input);
      expect(workshop).toEqual(preview);
      expect(workshop.type).toBe("workshop");
      expect(workshop.createdById).toBe("instructor");
      expect(workshop.fields).not.toHaveProperty("eggheadSale");
      expect(test.writes()).toBe(1);
      const encoded = yield* Schema.encode(Workshop)(workshop);
      expect(encoded.id).toBe(`workshop~${input.requestId}`);
    }).pipe(Effect.provide(test.services));
  });

  it.effect("denied approval fails before any write", () => {
    const test = fixture({ approved: false });
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(createWorkshop.run(input));
      expect(failure.code).toBe("ApprovalDenied");
      expect(test.writes()).toBe(0);
    }).pipe(Effect.provide(test.services));
  });

  it.effect("creation permission cannot be replaced by confirmation", () => {
    const test = fixture({ canCreate: false });
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(createWorkshop.run(input));
      expect(failure.code).toBe("Unauthorized");
      expect(test.writes()).toBe(0);
    }).pipe(Effect.provide(test.services));
  });

  it.effect("rejects bad schedule, bad zone, and provider fields before storage", () => {
    const test = fixture();
    return Effect.gen(function* () {
      for (const candidate of [
        { ...input, endsAt: input.startsAt },
        { ...input, startsAt: "2026-99-02T09:00:00Z" },
        { ...input, startsAt: "2026-02-31T09:00:00Z" },
        { ...input, timezone: "Mars/Base" },
        { ...input, flagKey: "obsolete-flag" },
        { ...input, createdById: "another-user" },
      ]) {
        const failure = yield* Effect.flip(createWorkshop.run(candidate));
        expect(["InvalidWorkshop", "InvalidInput"]).toContain(failure.code);
      }
      expect(test.writes()).toBe(0);
    }).pipe(Effect.provide(test.services));
  });

  it.effect("patch validation merges current schedule and stale edits cannot overwrite it", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const workshop = yield* createWorkshop.run(input);
      const invalid = yield* Effect.flip(
        previewUpdateWorkshop.run({
          id: workshop.id,
          expectedRevision: 1,
          changes: { startsAt: "2026-11-03T09:00:00Z" },
        }),
      );
      expect(invalid.code).toBe("InvalidWorkshop");
      const update = {
        id: workshop.id,
        expectedRevision: 1,
        changes: { title: "Revised Workshop" },
      };
      const preview = yield* previewUpdateWorkshop.run(update);
      expect(test.writes()).toBe(1);
      const revised = yield* updateWorkshop.run(update);
      expect(revised).toEqual(preview);
      expect(revised.fields.workshopRevision).toBe(2);
      const stale = yield* Effect.flip(updateWorkshop.run(update));
      expect(stale.code).toBe("Conflict");
      expect(test.writes()).toBe(2);
      const duplicate = yield* Effect.flip(createWorkshop.run(input));
      expect(duplicate.code).toBe("Conflict");
    }).pipe(Effect.provide(test.services));
  });

  it.effect("list and inspect do not expose another owner’s draft", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const own = yield* createWorkshop.run(input);
      test.rows.set("other-workshop", {
        ...own,
        id: "other-workshop",
        createdById: "someone-else",
      });
      const page = yield* listWorkshops.run({ limit: 1 });
      expect(page.workshops.map((row) => row.id)).toEqual([own.id]);
      const hidden = yield* Effect.flip(getWorkshop.run({ id: "other-workshop" }));
      expect(hidden.code).toBe("NotFound");
      const oversized = yield* Effect.flip(listWorkshops.run({ limit: 51 }));
      expect(oversized.code).toBe("InvalidInput");
    }).pipe(Effect.provide(test.services));
  });

  it("registers honest write, read, and preview metadata once", () => {
    expect(capabilities.map(({ contract }) => contract.name)).toEqual([
      "list_workshops",
      "get_workshop",
      "preview_create_workshop",
      "create_workshop",
      "preview_update_workshop",
      "update_workshop",
    ]);
    expect(createWorkshop.contract.needsApproval).toBe(true);
    expect(createWorkshop.contract.annotations.idempotent).toBe(false);
    expect(previewCreateWorkshop.contract.annotations.readOnly).toBe(true);
  });

  it.effect.prop(
    "all nonpositive durations fail without writes",
    { duration: Schema.Number.pipe(Schema.int(), Schema.between(-10000, 0)) },
    ({ duration }) => {
      const test = fixture();
      return Effect.gen(function* () {
        const failure = yield* Effect.flip(
          createWorkshop.run({
            ...input,
            startsAt: "2026-11-02T16:00:00Z",
            endsAt: new Date(Date.parse("2026-11-02T16:00:00Z") + duration * 60000).toISOString(),
          }),
        );
        expect(failure.code).toBe("InvalidWorkshop");
        expect(test.writes()).toBe(0);
      }).pipe(Effect.provide(test.services));
    },
  );
});
