import { NextResponse } from 'next/server'
import { decideAccess } from '@/server/access-policy'
import { auth } from '@/server/auth'

/**
 * Closes the builder to anyone without a contributor or admin session.
 * See `src/server/access-policy.ts` for the exemptions. Server actions and
 * route handlers keep their own checks; this is the outer gate, not the only one.
 */
export const proxy = auth((req) => {
	const { pathname } = req.nextUrl
	const user = req.auth?.user as
		| { id?: string; role?: string; roles?: { name: string }[] }
		| undefined
	const roles = [
		...(user?.roles ?? []).map((r) => r.name),
		...(user?.role ? [user.role] : []),
	]

	const access = decideAccess(pathname, {
		signedIn: Boolean(user?.id),
		roles,
		hasBearer: /^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? ''),
		preflight: req.method === 'OPTIONS',
	})

	if (access === 'allow') return NextResponse.next()

	const isPageNavigation =
		access === 'login' &&
		(req.method === 'GET' || req.method === 'HEAD') &&
		!req.headers.get('next-action')

	if (isPageNavigation) {
		const login = new URL('/login', req.nextUrl.origin)
		login.searchParams.set('callbackUrl', `${pathname}${req.nextUrl.search}`)
		return NextResponse.redirect(login)
	}

	return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
})

export const config = {
	matcher: ['/((?!_next/static|_next/image).*)'],
}
