import { Context, Effect } from "effect";
import { implement } from "./capability";
import {
  createWorkshopContract,
  getWorkshopContract,
  listWorkshopsContract,
  previewCreateWorkshopContract,
  previewUpdateWorkshopContract,
  updateWorkshopContract,
  WorkshopFailure,
  type Workshop,
  type WorkshopPage,
  type CreateWorkshopInput,
} from "./contracts";

export class WorkshopActor extends Context.Tag("egghead/WorkshopActor")<
  WorkshopActor,
  {
    readonly id: string;
    readonly canCreate: boolean;
    readonly canManageAll: boolean;
    readonly canManage: (workshop: Workshop) => boolean;
  }
>() {}

export class WorkshopStore extends Context.Tag("egghead/WorkshopStore")<
  WorkshopStore,
  {
    readonly get: (id: string) => Effect.Effect<Workshop | null, WorkshopFailure>;
    readonly list: (input: {
      limit: number;
      cursor?: string | undefined;
      ownerId?: string | undefined;
    }) => Effect.Effect<typeof WorkshopPage.Type, WorkshopFailure>;
    readonly create: (workshop: Workshop) => Effect.Effect<Workshop, WorkshopFailure>;
    readonly revise: (
      workshop: Workshop,
      expectedRevision: number,
    ) => Effect.Effect<Workshop, WorkshopFailure>;
  }
>() {}

function validCalendarDate(value: string) {
  const localComponents = value.slice(0, 19);
  const parsed = new Date(`${localComponents}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === localComponents;
}

function validateWorkshop(workshop: Workshop) {
  const { startsAt, endsAt, timezone, title } = workshop.fields;
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !validCalendarDate(startsAt) ||
    !validCalendarDate(endsAt) ||
    end <= start ||
    title.trim().length < 2
  ) {
    return Effect.fail(
      new WorkshopFailure({
        code: "InvalidWorkshop",
        message: "A Workshop needs a title and an end after its start",
      }),
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(start);
  } catch {
    return Effect.fail(
      new WorkshopFailure({
        code: "InvalidWorkshop",
        message: "Workshop timezone must be a valid IANA timezone",
      }),
    );
  }
  return Effect.succeed({
    ...workshop,
    fields: {
      ...workshop.fields,
      title: title.trim(),
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
    },
  });
}

const prepareCreate = (input: typeof CreateWorkshopInput.Type) =>
  Effect.gen(function* () {
    const actor = yield* WorkshopActor;
    if (!actor.canCreate) {
      return yield* Effect.fail(
        new WorkshopFailure({ code: "Unauthorized", message: "Workshop creation is not allowed" }),
      );
    }
    const id = `workshop~${input.requestId}`;
    return yield* validateWorkshop({
      id,
      type: "workshop",
      createdById: actor.id,
      fields: {
        title: input.title.trim(),
        slug: id,
        description: input.description,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        attendeeInstructions: input.attendeeInstructions,
        ...(input.landingPage ? { landingPage: input.landingPage } : {}),
        state: "draft",
        visibility: "unlisted",
        workshopRevision: 1,
      },
    });
  });

const loadManagedWorkshop = (id: string) =>
  Effect.gen(function* () {
    const actor = yield* WorkshopActor;
    const store = yield* WorkshopStore;
    const workshop = yield* store.get(id);
    if (!workshop || !actor.canManage(workshop)) {
      return yield* Effect.fail(
        new WorkshopFailure({ code: "NotFound", message: "Workshop not found" }),
      );
    }
    return workshop;
  });

const prepareUpdate = (input: typeof updateWorkshopContract.input.Type) =>
  Effect.gen(function* () {
    const current = yield* loadManagedWorkshop(input.id);
    if (current.fields.workshopRevision !== input.expectedRevision) {
      return yield* Effect.fail(
        new WorkshopFailure({
          code: "Conflict",
          message: "Workshop changed; inspect and preview it again",
        }),
      );
    }
    if (Object.keys(input.changes).length === 0) {
      return yield* Effect.fail(
        new WorkshopFailure({
          code: "InvalidWorkshop",
          message: "Supply at least one Workshop change",
        }),
      );
    }
    return yield* validateWorkshop({
      ...current,
      fields: {
        ...current.fields,
        ...input.changes,
        workshopRevision: current.fields.workshopRevision + 1,
      },
    });
  });

export const listWorkshops = implement(listWorkshopsContract, (input) =>
  Effect.gen(function* () {
    const actor = yield* WorkshopActor;
    const store = yield* WorkshopStore;
    return yield* store.list({ ...input, ownerId: actor.canManageAll ? undefined : actor.id });
  }),
);
export const getWorkshop = implement(getWorkshopContract, ({ id }) => loadManagedWorkshop(id));
export const previewCreateWorkshop = implement(previewCreateWorkshopContract, prepareCreate);
export const createWorkshop = implement(createWorkshopContract, (input) =>
  Effect.gen(function* () {
    const workshop = yield* prepareCreate(input);
    const store = yield* WorkshopStore;
    return yield* store.create(workshop);
  }),
);
export const previewUpdateWorkshop = implement(previewUpdateWorkshopContract, prepareUpdate);
export const updateWorkshop = implement(updateWorkshopContract, (input) =>
  Effect.gen(function* () {
    const workshop = yield* prepareUpdate(input);
    const store = yield* WorkshopStore;
    return yield* store.revise(workshop, input.expectedRevision);
  }),
);

export const capabilities = [
  listWorkshops,
  getWorkshop,
  previewCreateWorkshop,
  createWorkshop,
  previewUpdateWorkshop,
  updateWorkshop,
] as const;

export type WorkshopCapability = (typeof capabilities)[number];
