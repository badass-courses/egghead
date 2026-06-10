import { NextRequest, NextResponse } from 'next/server'
import { withSkill } from '@/server/with-skill'
import { ourFileRouter } from '@/uploadthing/core'
import { createRouteHandler } from 'uploadthing/next'

const hasUploadThingEnv = Boolean(
	process.env.UPLOADTHING_SECRET && process.env.UPLOADTHING_APP_ID,
)

// Create route handler with proper error logging
const handlers = createRouteHandler({
	router: ourFileRouter,
})

const missingUploadThingEnvResponse = () =>
	NextResponse.json(
		{
			error:
				'UploadThing is not configured. Set UPLOADTHING_SECRET and UPLOADTHING_APP_ID.',
		},
		{ status: 500 },
	)

// Wrap handlers with try/catch for better error reporting
const wrappedGET = async (req: NextRequest) => {
	if (!hasUploadThingEnv) {
		return missingUploadThingEnvResponse()
	}

	try {
		return await handlers.GET(req)
	} catch (error) {
		console.error('UploadThing GET error:', error)
		return NextResponse.json(
			{ error: 'Internal Server Error in upload handler' },
			{ status: 500 },
		)
	}
}

const wrappedPOST = async (req: NextRequest) => {
	if (!hasUploadThingEnv) {
		return missingUploadThingEnvResponse()
	}

	try {
		return await handlers.POST(req)
	} catch (error) {
		console.error('UploadThing POST error:', error)
		return NextResponse.json(
			{ error: 'Internal Server Error in upload handler' },
			{ status: 500 },
		)
	}
}

export const GET = withSkill(wrappedGET)
export const POST = withSkill(wrappedPOST)
