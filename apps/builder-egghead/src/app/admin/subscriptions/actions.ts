'use server'

import { revalidatePath } from 'next/cache'
import {
	createSubscriptionProduct,
	updateSubscriptionProduct,
} from '@/lib/subscription-products'
import { parseSubscriptionProductForm } from '@/lib/subscription-products-contracts'
import { z } from 'zod'

export type SubscriptionProductActionState = {
	status: 'idle' | 'error' | 'success'
	message: string | null
}


function actionErrorMessage(error: unknown) {
	if (error instanceof z.ZodError) {
		return error.issues.at(0)?.message ?? 'Check the subscription product values.'
	}
	return error instanceof Error ? error.message : 'Subscription product update failed.'
}

export async function createSubscriptionProductAction(
	_previousState: SubscriptionProductActionState,
	formData: FormData,
): Promise<SubscriptionProductActionState> {
	try {
		const input = parseSubscriptionProductForm(formData)
		await createSubscriptionProduct(input)
		revalidatePath('/admin/subscriptions')
		return {
			status: 'success',
			message: `${input.name} was created in CourseBuilder and Stripe.`,
		}
	} catch (error) {
		return { status: 'error', message: actionErrorMessage(error) }
	}
}

export async function updateSubscriptionProductAction(
	_previousState: SubscriptionProductActionState,
	formData: FormData,
): Promise<SubscriptionProductActionState> {
	try {
		const input = parseSubscriptionProductForm(formData)
		await updateSubscriptionProduct(input)
		revalidatePath('/admin/subscriptions')
		return {
			status: 'success',
			message: `${input.name} was updated in CourseBuilder and Stripe.`,
		}
	} catch (error) {
		return { status: 'error', message: actionErrorMessage(error) }
	}
}
