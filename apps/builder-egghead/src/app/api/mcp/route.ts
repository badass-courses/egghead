import { NextRequest } from 'next/server'
import { buildMcpServer } from '@/lib/mcp/server'
import { getUserAbilityForRequest } from '@/server/ability-for-request'

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const unauthorized = () =>
	new Response(JSON.stringify({ error: 'Unauthorized' }), {
		status: 401,
		headers: {
			'Content-Type': 'application/json',
			'WWW-Authenticate': 'Bearer realm="egghead-builder"',
		},
	})

const methodNotAllowed = () =>
	new Response(null, { status: 405, headers: { Allow: 'POST' } })

/**
 * Stateless MCP endpoint (Streamable HTTP). Auth is the Builder's device
 * access token; the caller must be able to create Content.
 */
export async function POST(request: NextRequest) {
	const { user, ability } = await getUserAbilityForRequest(request)
	if (!user || ability.cannot('create', 'Content')) {
		return unauthorized()
	}

	const server = buildMcpServer({ user, ability })
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})
	await server.connect(transport)
	return transport.handleRequest(request)
}

export function GET() {
	return methodNotAllowed()
}

export function DELETE() {
	return methodNotAllowed()
}
