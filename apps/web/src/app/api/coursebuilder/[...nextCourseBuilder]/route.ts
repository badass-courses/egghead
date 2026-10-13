import { handleSubscriptionDeletion } from "../../../../subscriptions/webhook";
import { handlers } from "../../../../coursebuilder/config";

export const GET = handlers.GET;
export async function POST(request: Parameters<typeof handlers.POST>[0]) {
  return (await handleSubscriptionDeletion(request)) ?? handlers.POST(request);
}
