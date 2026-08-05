import { createHash } from "node:crypto";

export function gravatarUrlForEmail(email: string, size: number) {
  const hash = createHash("md5").update(email.trim().toLowerCase()).digest("hex");
  const query = new URLSearchParams({ d: "404", r: "g", s: String(size) });

  return `https://www.gravatar.com/avatar/${hash}?${query.toString()}`;
}
