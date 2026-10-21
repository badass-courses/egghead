/** External portraits render in the browser, bypassing the server image optimizer. */
export function workshopInstructorImage(value: string | undefined) {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password
    ? { src: url.href, unoptimized: true }
    : null;
}
