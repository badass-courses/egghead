/**
 * Who may reach which path on the builder. Pure, so it can be tested without
 * a request, a database or a session store; `src/proxy.ts` applies it.
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
}

const PUBLIC_PREFIXES = [
	'/login',
	'/check-your-email',
	'/privacy',
	'/unsubscribed',
	'/robots.txt',
	'/favicon',
	'/_next/',
	'/api/auth/',
	'/oauth/',
	'/invites/',
	// Machine callers with their own authentication.
	'/api/inngest',
	'/api/mux/webhook',
	'/api/coursebuilder/',
	'/api/uploadthing',
	'/api/cron',
]

const SIGNED_IN_PREFIXES = ['/activate']

const BEARER_API_PREFIXES = [
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

const isStaticAsset = (pathname: string) =>
	/\.(?:png|jpe?g|gif|svg|webp|ico|txt|xml|webmanifest|woff2?|ttf|css|js|map)$/i.test(pathname)

export function decideAccess(pathname: string, requester: Requester): Access {
	if (isStaticAsset(pathname)) return 'allow'
	if (PUBLIC_PREFIXES.some((p) => matches(pathname, p))) return 'allow'

	const isEditor = requester.signedIn && requester.roles.some((r) => EDITOR_ROLES.has(r))
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
