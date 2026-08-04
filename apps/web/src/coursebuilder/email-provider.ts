import { sendVerificationRequest } from "@coursebuilder/core/lib/send-verification-request";
import PostmarkProvider from "next-auth/providers/postmark";

import { getCourseBuilderAdapter } from "../db/adapter";

type PostmarkEmailProviderOptions = {
  apiKey: string;
  from: string;
};

export function createPostmarkEmailProvider({ apiKey, from }: PostmarkEmailProviderOptions) {
  return PostmarkProvider({
    apiKey,
    from,
    sendVerificationRequest: (params) => sendVerificationRequest(params, getCourseBuilderAdapter()),
  });
}
