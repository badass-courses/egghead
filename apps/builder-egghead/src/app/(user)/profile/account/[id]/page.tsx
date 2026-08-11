import { redirect } from 'next/navigation'
import { Layout } from '@/components/app/layout'
import { db } from '@/db'
import { getServerAuthSession } from '@/server/auth'

import EditAccountForm from '../../_components/edit-account-form'

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

	return (
		<Layout>
			<main className="max-w-(--breakpoint-sm) mx-auto w-full">
				<EditAccountForm user={fullUser} />
			</main>
		</Layout>
	)
}
