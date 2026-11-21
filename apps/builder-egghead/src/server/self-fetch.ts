/**
 * Headers for the builder calling its own public URL from the server (for
 * example `/api/auth/csrf` while rendering `/login`).
 *
 * With Vercel Deployment Protection on, such a request gets the Vercel SSO
 * redirect instead of the app, and parsing that HTML as JSON throws, so the
 * page renders a 500. Vercel exposes `VERCEL_AUTOMATION_BYPASS_SECRET` to the
 * deployment when Protection Bypass for Automation is configured; sending it
 * lets the server reach itself. Without the variable this adds nothing.
 * See https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
 */
export function selfFetchHeaders(): Record<string, string> {
	const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
	return bypass ? { 'x-vercel-protection-bypass': bypass } : {}
}
