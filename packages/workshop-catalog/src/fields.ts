import * as Schema from "effect/Schema";

export const WorkshopFields = Schema.Union([
  Schema.JsonObject,
  Schema.fromJsonString(Schema.JsonObject),
]);

export type JsonFields = Record<string, unknown>;

export function objectField(fields: JsonFields, key: string): JsonFields | null {
  const value = fields[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

export function stringField(fields: JsonFields, key: string): string | null {
  const value = fields[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "null") return null;
  return trimmed ? trimmed : null;
}

function stripMarkdownForExcerpt(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerptField(fields: JsonFields, maxLength = 260): string {
  const value = stringField(fields, "summary") ?? stringField(fields, "description") ?? "";
  if (!value) return "";

  const firstParagraph = value
    .split(/\n{2,}/)
    .map((part) => stripMarkdownForExcerpt(part))
    .find(Boolean);
  const excerpt = firstParagraph ?? stripMarkdownForExcerpt(value);

  if (excerpt.length <= maxLength) return excerpt;
  return `${excerpt.slice(0, maxLength).replace(/\s+\S*$/, "")}...`;
}

export function descriptionField(fields: JsonFields): string {
  const value = excerptField(fields);
  if (!value) return "";
  if (/content manifest rehearsal/i.test(value)) return "";
  if (/legacy public archive route preserved/i.test(value)) return "";
  return value;
}
