/**
 * Headers for the builder calling its own public URL from the server (for
 * example `/api/auth/csrf` while rendering `/login`).
 *
 * With Vercel Deployment Protection on, such a request gets the Vercel SSO
 * redirect instead of the app, and parsing that HTML as JSON throws, so the
 * page renders a 500. Vercel exposes `VERCEL_AUTOMATION_BYPASS_SECRET` to the
 * deployment when Protection Bypass for Automation is configured; sending it
 * lets the server reach itself.
 *
 * The secret goes only to this deployment's own hosts, as Vercel reports them
 * (`VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`). Any
 * other URL, or a missing secret, gets no header.
 * See https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
 */
export function selfFetchHeaders(url: string): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!bypass) return {};
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return {};
  }
  const ownHosts = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]
    .filter((h): h is string => Boolean(h))
    .map((h) => h.toLowerCase());
  return ownHosts.includes(host)
    ? { "x-vercel-protection-bypass": bypass }
    : {};
}
