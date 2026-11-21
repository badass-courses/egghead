/**
 * Who may reach which path on the builder. Pure, so it can be tested without
 * a request, a database or a session store; `src/proxy.ts` applies it.
 *
 * Server actions are dispatched by their `Next-Action` id whatever the URL,
 * so a path rule can't gate them. Requests carrying that header from anyone
 * but an editor are refused except on invite pages, and every exported action
 * still checks its caller itself; that per-action check is the real gate.
 *
 * The builder is a staff and instructor tool. Everything is closed to anyone
 * without a contributor or admin role, except:
 * - sign-in and static pages;
 * - machine callers that authenticate themselves (Inngest signs its
 *   requests, the Mux webhook checks its signature, Deepgram and UploadThing
 *   callbacks go through their own handlers, the OAuth device flow checks its
 *   own tokens);
 * - API routes called with a bearer device token, which check it themselves;
 * - instructor invite pages, which invitees open before they have an account;
 *   the invite actions check the invite itself (admin-created, unexpired,
 *   accepted only for the invited email);
 * - device-activation pages, which any signed-in account may open.
 */
export type Access = 'allow' | 'login' | 'deny'

export type Requester = {
	signedIn: boolean
	roles: readonly string[]
	hasBearer: boolean
	/** A CORS preflight (OPTIONS), which never carries credentials. */
	preflight?: boolean
	/** The request invokes a server action (`Next-Action` header). */
	serverAction?: boolean
}

const PUBLIC_PREFIXES = [
	'/login',
	'/check-your-email',
	'/privacy',
	'/unsubscribed',
	'/robots.txt',
	'/_next/',
	'/api/auth/',
	'/oauth/',
	'/invites/',
	// Machine callers with their own authentication.
	'/api/inngest',
	'/api/mux/webhook',
	'/api/coursebuilder/webhook/',
	'/api/uploadthing',
	'/api/cron',
]

const SIGNED_IN_PREFIXES = ['/activate']

const BEARER_API_PREFIXES = [
	'/api/content-mcp',
	'/api/posts',
	'/api/tags',
	'/api/videos/',
	'/api/uploads/',
	'/api/mux',
]

const EDITOR_ROLES = new Set(['admin', 'contributor'])

const matches = (pathname: string, prefix: string) =>
	prefix.endsWith('/')
		? pathname.startsWith(prefix) || pathname === prefix.slice(0, -1)
		: pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`)

// Files in public/, by exact name. Never match by extension: a dynamic route
// such as /api/tags/[postId] or /[post] would accept `x.js` as its param.
const PUBLIC_FILES = new Set([
	'/android-chrome-192x192.png',
	'/android-chrome-512x512.png',
	'/apple-touch-icon.png',
	'/browserconfig.xml',
	'/epic-web-flows.png',
	'/event-diagram.png',
	'/favicon-16x16.png',
	'/favicon-32x32.png',
	'/favicon.ico',
	'/mstile-150x150.png',
	'/safari-pinned-tab.svg',
	'/site.webmanifest',
	'/stack.png',
])

export function decideAccess(pathname: string, requester: Requester): Access {
	const isEditor = requester.signedIn && requester.roles.some((r) => EDITOR_ROLES.has(r))

	if (requester.serverAction) {
		return isEditor || matches(pathname, '/invites/') ? 'allow' : 'deny'
	}

	if (PUBLIC_FILES.has(pathname)) return 'allow'
	if (PUBLIC_PREFIXES.some((p) => matches(pathname, p))) return 'allow'

	if (isEditor) return 'allow'

	if (SIGNED_IN_PREFIXES.some((p) => matches(pathname, p))) {
		return requester.signedIn ? 'allow' : 'login'
	}

	// Device-token API clients; each route checks the token's ability itself.
	if ((requester.hasBearer || requester.preflight) && BEARER_API_PREFIXES.some((p) => matches(pathname, p))) {
		return 'allow'
	}

	return pathname.startsWith('/api/') || pathname.startsWith('/trpc') ? 'deny' : 'login'
}
