import { notFound } from "next/navigation";

// A route param as the visitor typed it, or null for malformed
// percent-encoding (for example /blog/%E0%A4%A).
export function decodeSlugParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// Malformed percent-encoding in a content URL is a 404, not a thrown URIError
// and a 500.
export function slugParamOrNotFound(raw: string): string {
  const decoded = decodeSlugParam(raw);
  if (decoded === null) notFound();
  return decoded;
}
