import type { Actor } from '@/lib/events-mutations'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerWorkshopTools } from './tools'

export const MCP_SERVER_INFO = {
	name: 'egghead-builder',
	version: '0.1.0',
} as const

/**
 * One server per request. The route resolves the actor from the bearer
 * token and every tool runs with that actor's ability.
 */
export function buildMcpServer(actor: Actor) {
	const server = new McpServer(MCP_SERVER_INFO, {
		instructions: [
			'Tools for scheduling egghead live workshops.',
			'Write tools are dry runs unless confirm is true: show the returned plan to the operator and ask before confirming.',
			'go_live and end_sale change what egghead.io sells. Never call them with confirm: true without an explicit yes from the operator in this conversation.',
			'After any write, report the re-read state the tool returns, not the request you sent.',
		].join(' '),
	})
	registerWorkshopTools(server, actor)
	return server
}
