import { NextRequest, NextResponse } from 'next/server'
import { isContentEditorRequest } from '@/server/editor-for-request'
import { getSignedUrlForVideoFile } from '@/video-uploader/get-signed-s3-url'

export const GET = async (request: NextRequest) => {
	if (!(await isContentEditorRequest(request))) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
	}
	const searchParams = new URL(request.url).searchParams
	const filename = searchParams.get('objectName')

	if (filename) {
		const signedUrl = await getSignedUrlForVideoFile({ filename })
		return NextResponse.json(signedUrl, {
			status: 200,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			},
		})
	}

	return NextResponse.json(
		{ error: 'No filename provided' },
		{
			status: 400,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			},
		},
	)
}
