import { workshopFullPrice, workshopStatus } from "@egghead/workshops/policy";

import { createWorkshopMysqlConnection } from "../apps/web/src/workshops/catalog";

function assertEqual(
  name: string,
  actual: number | string | null,
  expected: number | string | null,
) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  }

  return { name, pass: true as const };
}

const now = new Date("2026-01-15T12:00:00.000Z");
const checks = [
  assertEqual(
    "workshop without a start remains schedule-pending",
    workshopStatus(null, null, now),
    "schedule-pending",
  ),
  assertEqual(
    "future workshop without an end remains upcoming",
    workshopStatus("2026-01-16T12:00:00.000Z", null, now),
    "upcoming",
  ),
  assertEqual(
    "started workshop without an end becomes past",
    workshopStatus("2026-01-14T12:00:00.000Z", null, now),
    "past",
  ),
  assertEqual(
    "started workshop with a future end remains in progress",
    workshopStatus("2026-01-14T12:00:00.000Z", "2026-01-16T12:00:00.000Z", now),
    "in-progress",
  ),
  assertEqual(
    "invalid end date falls back to start date",
    workshopStatus("2026-01-14T12:00:00.000Z", "not-a-date", now),
    "past",
  ),
  assertEqual("missing active price is not free", workshopFullPrice(null), null),
  assertEqual("explicit zero-dollar price remains free", workshopFullPrice(0), 0),
  assertEqual("numeric string price is normalized", workshopFullPrice("149"), 149),
];

console.log(JSON.stringify({ checks }, null, 2));

const originalRuntime = process.env["EGGHEAD_RUNTIME"];
try {
  process.env["EGGHEAD_RUNTIME"] = "production";
  let blocked = false;
  try {
    await createWorkshopMysqlConnection();
  } catch (error) {
    blocked =
      error instanceof Error &&
      error.message === "Production workshop reads require an approved read flip";
  }
  if (!blocked) throw new Error("Workshop reads must remain blocked in production");
  console.log(JSON.stringify({ name: "production workshop reads remain blocked", pass: true }));
} finally {
  if (originalRuntime === undefined) delete process.env["EGGHEAD_RUNTIME"];
  else process.env["EGGHEAD_RUNTIME"] = originalRuntime;
}
