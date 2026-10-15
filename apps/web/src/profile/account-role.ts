export const EGGHEAD_BUILDER_URL = "https://builder.egghead.io";

type EggheadAccountRole = "admin" | "contributor" | "user";

export type StaffAccountPresentation = {
  actionLabel: string;
  description: string;
  heading: string;
  status: string;
};

export function staffAccountPresentation(
  role: EggheadAccountRole,
): StaffAccountPresentation | null {
  if (role === "contributor") {
    return {
      actionLabel: "Open instructor dashboard",
      description:
        "Create and manage your lessons, courses, and other instructor activity in the egghead builder.",
      heading: "Manage your instructor activity",
      status: "Instructor account",
    };
  }

  if (role === "admin") {
    return {
      actionLabel: "Open egghead builder",
      description: "Manage egghead content and instructor activity in the egghead builder.",
      heading: "Manage egghead content",
      status: "Administrator account",
    };
  }

  return null;
}
