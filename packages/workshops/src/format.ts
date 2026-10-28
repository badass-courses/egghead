import type { Workshop } from "./contracts";

export function formatWorkshopDate(workshop: Pick<Workshop, "startsAt" | "timezone">) {
  if (!workshop.startsAt) return "Schedule coming soon";

  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: workshop.timezone,
    }).format(new Date(workshop.startsAt));
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(workshop.startsAt));
  }
}

export function formatWorkshopPrice(price: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: Number.isInteger(price) ? 0 : 2,
    style: "currency",
  }).format(price);
}
