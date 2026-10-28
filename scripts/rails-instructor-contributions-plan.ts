import { createHash } from "node:crypto";

export type LegacyAuthorship = {
  id: string;
  slug: string | null;
  userId: string;
};
export type MigratedAuthorshipResource = {
  id: string;
  family: "lesson" | "course";
  railsId: string | null;
  slug: string | null;
};
export type InstructorIdentity = { id: string; railsUserId: string; name: string | null };
export type PlannedContribution = { id: string; contentId: string; userId: string };

function uniqueLookup<T>(rows: readonly T[], key: (row: T) => string | null) {
  const lookup = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    if (value) lookup.set(value, [...(lookup.get(value) ?? []), row]);
  }
  return lookup;
}

export function planRailsInstructorContributions({
  resources,
  lessons,
  courses,
  users,
}: {
  resources: readonly MigratedAuthorshipResource[];
  lessons: readonly LegacyAuthorship[];
  courses: readonly LegacyAuthorship[];
  users: readonly InstructorIdentity[];
}) {
  const sources = {
    lesson: {
      ids: uniqueLookup(lessons, (row) => row.id),
      slugs: uniqueLookup(lessons, (row) => row.slug),
    },
    course: {
      ids: uniqueLookup(courses, (row) => row.id),
      slugs: uniqueLookup(courses, (row) => row.slug),
    },
  };
  const identities = uniqueLookup(users, (row) => row.railsUserId);
  const contributions: PlannedContribution[] = [];
  let blocked = 0;
  let withoutLegacyMatch = 0;
  for (const resource of resources) {
    const source = sources[resource.family];
    const byId = resource.railsId ? source.ids.get(resource.railsId) : undefined;
    const bySlug = resource.slug ? source.slugs.get(resource.slug) : undefined;
    const candidates = resource.railsId ? byId : bySlug;
    const author = candidates?.length === 1 ? candidates[0] : undefined;
    if (!author) {
      if (resource.railsId || (candidates?.length ?? 0) > 1) blocked += 1;
      else withoutLegacyMatch += 1;
      continue;
    }
    if (byId && bySlug && (bySlug.length !== 1 || bySlug[0]?.id !== author.id)) {
      blocked += 1;
      continue;
    }
    const matches = identities.get(author.userId);
    const user = matches?.length === 1 ? matches[0] : undefined;
    if (!user?.name?.trim()) {
      blocked += 1;
      continue;
    }
    contributions.push({
      id: `rails-instructor_${createHash("sha256")
        .update(JSON.stringify([resource.id, user.id]))
        .digest("hex")}`,
      contentId: resource.id,
      userId: user.id,
    });
  }
  if (new Set(resources.map((row) => row.id)).size !== resources.length)
    throw new Error("Duplicate resource IDs.");
  const ordered = contributions.toSorted((a, b) => a.id.localeCompare(b.id));
  return {
    contributions: ordered,
    blocked,
    withoutLegacyMatch,
    digest: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
  };
}
