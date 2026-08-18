import { getEnv } from "../env";

const POSTMARK_EMAIL_ENDPOINT = "https://api.postmarkapp.com/email";

export type OutboundEmail = {
  from: string;
  html: string;
  subject: string;
  text: string;
  to: string;
};

type SendEmailOptions = {
  apiKey: string | undefined;
  deliveryEnabled?: boolean;
  fetchEmail?: typeof fetch;
  log?: (message: string) => void;
};

export function isEmailDeliveryEnabled(rawValue?: string) {
  return rawValue?.trim().toLowerCase() === "true";
}

export function formatSuppressedEmail(email: OutboundEmail) {
  return [
    "",
    "^^^^^^^^^^^^^^^^ EMAIL DELIVERY SUPPRESSED ^^^^^^^^^^^^^^^^",
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    "",
    email.text,
    "^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
    "",
  ].join("\n");
}

export function formatMagicSignInLink(url: string) {
  return [
    "",
    "^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
    "",
    "                    MAGIC SIGN-IN LINK",
    "",
    url,
    "",
    "^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
    "",
  ].join("\n");
}

export async function sendEmail(
  email: OutboundEmail,
  {
    apiKey,
    deliveryEnabled = isEmailDeliveryEnabled(getEnv("SEND_EMAILS")),
    fetchEmail = fetch,
    log = console.info,
  }: SendEmailOptions,
) {
  if (!deliveryEnabled) {
    log(formatSuppressedEmail(email));
    return { status: "suppressed" } as const;
  }

  if (!apiKey) {
    throw new Error("SEND_EMAILS=true requires POSTMARK_API_KEY");
  }

  const response = await fetchEmail(POSTMARK_EMAIL_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": apiKey,
    },
    body: JSON.stringify({
      From: email.from,
      To: email.to,
      Subject: email.subject,
      TextBody: email.text,
      HtmlBody: email.html,
      MessageStream: "outbound",
    }),
  });

  if (!response.ok) {
    throw new Error(`Postmark request failed with status ${response.status}`);
  }

  return { status: "sent" } as const;
}
