import { PostPurchaseLoginEmail } from "@coursebuilder/email-templates/emails/post-purchase-login";
import { render } from "@react-email/components";
import PostmarkProvider from "next-auth/providers/postmark";

import { getCourseBuilderAdapter } from "../db/adapter";
import { formatMagicSignInLink, sendEmail } from "./email-delivery";

const EGGHEAD_SIGN_IN_SUBJECT = "Log in to egghead";
const SUPPRESSED_EMAIL_API_KEY = "email-delivery-suppressed";

type PostmarkEmailProviderOptions = {
  apiKey: string | undefined;
  from: string;
};

export function createPostmarkEmailProvider({ apiKey, from }: PostmarkEmailProviderOptions) {
  return PostmarkProvider({
    apiKey: apiKey ?? SUPPRESSED_EMAIL_API_KEY,
    from,
    sendVerificationRequest: async ({ identifier, url }) => {
      const adapter = getCourseBuilderAdapter();
      const user =
        process.env["CREATE_USER_ON_LOGIN"] === "false"
          ? await adapter.getUserByEmail?.(identifier)
          : await adapter.findOrCreateUser(identifier);

      if (!user) return;

      const { host } = new URL(url);
      const email = PostPurchaseLoginEmail({
        email: identifier,
        host,
        previewText: EGGHEAD_SIGN_IN_SUBJECT,
        siteName: "egghead",
        url,
      });
      const [htmlBody, textBody] = await Promise.all([
        render(email),
        render(email, { plainText: true }),
      ]);
      const result = await sendEmail(
        {
          from,
          to: identifier,
          subject: EGGHEAD_SIGN_IN_SUBJECT,
          text: textBody,
          html: htmlBody,
        },
        {
          apiKey,
        },
      );

      if (result.status === "suppressed") {
        console.info(formatMagicSignInLink(url));
      }
    },
  });
}
