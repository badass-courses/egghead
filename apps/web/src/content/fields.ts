export type JsonFields = Record<string, unknown>;

export function fieldsFromJson(value: unknown): JsonFields {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return fieldsFromJson(parsed);
    } catch {
      return {};
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }

  return {};
}

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

export function descriptionField(fields: JsonFields): string {
  const value = stringField(fields, "description") ?? stringField(fields, "summary") ?? "";
  if (!value) return "";
  if (/content manifest rehearsal/i.test(value)) return "";
  if (/legacy public archive route preserved/i.test(value)) return "";
  return value;
}

export function numberField(fields: JsonFields, key: string): number | null {
  const value = fields[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function booleanField(fields: JsonFields, key: string): boolean {
  return fields[key] === true;
}
