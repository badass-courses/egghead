export function searchHref({
  contentType,
  instructor,
  term,
}: {
  contentType?: string | undefined;
  instructor?: string | undefined;
  term?: string | undefined;
}) {
  const params = new URLSearchParams();
  if (term) params.set("q", term);
  if (contentType) params.set("type", contentType);
  if (instructor) params.set("instructor", instructor);
  return params.size > 0 ? `/q?${params}` : "/q";
}
