import { PostPurchaseLoginEmail } from "@coursebuilder/email-templates/emails/post-purchase-login";
import { render } from "@react-email/components";
import PostmarkProvider from "next-auth/providers/postmark";

import { getCourseBuilderAdapter } from "../db/adapter";

const EGGHEAD_SIGN_IN_SUBJECT = "Log in to egghead";

type PostmarkEmailProviderOptions = {
  apiKey: string;
  from: string;
};

export function createPostmarkEmailProvider({ apiKey, from }: PostmarkEmailProviderOptions) {
  return PostmarkProvider({
    apiKey,
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
      const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": apiKey,
        },
        body: JSON.stringify({
          From: from,
          To: identifier,
          Subject: EGGHEAD_SIGN_IN_SUBJECT,
          TextBody: textBody,
          HtmlBody: htmlBody,
          MessageStream: "outbound",
        }),
      });

      if (!response.ok) {
        throw new Error(`Postmark request failed with status ${response.status}`);
      }
    },
  });
}
