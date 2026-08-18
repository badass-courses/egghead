import { notFound, redirect } from 'next/navigation'
import { Layout } from '@/components/app/layout'
import { db } from '@/db'
import { getCurrentLearningStreakDays } from '@/lib/current-learning-streak'
import { getServerAuthSession } from '@/server/auth'

import EditProfileForm from '../_components/edit-profile-form'
import { LearningStreakBadge } from '../_components/learning-streak-badge'

type Props = {
	params: Promise<{ id: string }>
}

export default async function ProfilePage(props: Props) {
	const { session, ability } = await getServerAuthSession()
	const params = await props.params

	if (!ability.can('manage', 'all') && session.user?.id !== params.id) {
		redirect('/')
	}

	const fullUser = await db.query.users.findFirst({
		where: (users, { eq }) => eq(users.id, params.id),
		with: {
			profiles: true,
		},
	})
	if (!fullUser) notFound()

	const currentStreakDays = await getCurrentLearningStreakDays(params.id)

	return (
		<Layout>
			<main className="max-w-(--breakpoint-sm) mx-auto w-full">
				<div className="mb-6">
					<LearningStreakBadge days={currentStreakDays} />
				</div>
				<EditProfileForm user={fullUser} />
			</main>
		</Layout>
	)
}
