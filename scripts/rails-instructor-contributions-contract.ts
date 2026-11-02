import { deepEqual, equal } from "node:assert/strict";
import {
  planRailsInstructorContributions,
  type MigratedAuthorshipResource,
} from "./rails-instructor-contributions-plan";

export function contributionPlanChecks(): { name: string; pass: true }[] {
  const lesson: MigratedAuthorshipResource = {
    id: "fixture-lesson",
    family: "lesson",
    railsId: "10",
    slug: "fixture-lesson",
  };
  const course: MigratedAuthorshipResource = {
    id: "fixture-course",
    family: "course",
    railsId: null,
    slug: "fixture-course",
  };
  const input = {
    resources: [lesson, course],
    lessons: [{ id: "10", slug: "fixture-lesson", userId: "20" }],
    courses: [{ id: "30", slug: "fixture-course", userId: "20" }],
    users: [{ id: "fixture-instructor", railsUserId: "20", name: "Fixture Instructor" }],
  };
  const plan = planRailsInstructorContributions(input);
  equal(plan.blocked, 0);
  deepEqual(
    plan.contributions
      .map(({ contentId, userId }) => ({ contentId, userId }))
      .toSorted((a, b) => a.contentId.localeCompare(b.contentId)),
    [
      { contentId: "fixture-course", userId: "fixture-instructor" },
      { contentId: "fixture-lesson", userId: "fixture-instructor" },
    ],
  );
  equal(
    plan.digest,
    planRailsInstructorContributions({ ...input, resources: [course, lesson] }).digest,
  );
  equal(planRailsInstructorContributions({ ...input, users: [] }).blocked, 2);
  equal(
    planRailsInstructorContributions({
      ...input,
      users: [{ ...input.users[0], id: "fixture-instructor", railsUserId: "20", name: "" }],
    }).blocked,
    2,
  );
  const conflicting = planRailsInstructorContributions({
    ...input,
    lessons: [...input.lessons, { id: "11", slug: "fixture-lesson", userId: "20" }],
  });
  equal(conflicting.blocked, 1);
  equal(
    planRailsInstructorContributions({ ...input, resources: [{ ...lesson, railsId: "missing" }] })
      .blocked,
    1,
  );
  const modern = planRailsInstructorContributions({
    ...input,
    resources: [{ ...course, slug: "new-course" }],
  });
  equal(modern.withoutLegacyMatch, 1);
  equal(modern.contributions.length, 0);
  return [
    {
      name: "Rails backfill maps stable identities and unique slugs with repeatable IDs; missing and conflicting identities block",
      pass: true,
    },
  ];
}
