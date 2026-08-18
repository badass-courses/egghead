import {
  formatMagicSignInLink,
  formatSuppressedEmail,
  isEmailDeliveryEnabled,
  sendEmail,
  type OutboundEmail,
} from "../apps/web/src/coursebuilder/email-delivery";

type ContractCheck = {
  name: string;
  pass: true;
};

function pass(name: string): ContractCheck {
  return { name, pass: true };
}

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  }

  return pass(name);
}

function assertIncludes(name: string, actual: string, expected: string) {
  if (!actual.includes(expected)) {
    throw new Error(`${name}: expected string to include ${expected}`);
  }

  return pass(name);
}

async function expectReject(name: string, run: () => Promise<unknown>, expected: string) {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return pass(name);
    throw error;
  }

  throw new Error(`${name}: expected promise to reject`);
}

const email: OutboundEmail = {
  from: "egghead development <no-reply@egghead.local>",
  to: "developer@example.test",
  subject: "A useful development message",
  text: "This is the plain-text email body.",
  html: "<p>This is the HTML email body.</p>",
};
const logs: string[] = [];
let fetchCalls = 0;
const fakeFetch: typeof fetch = async () => {
  fetchCalls += 1;
  return new Response(null, { status: 200 });
};
const suppressedResult = await sendEmail(email, {
  apiKey: undefined,
  deliveryEnabled: false,
  fetchEmail: fakeFetch,
  log: (message) => logs.push(message),
});
const fetchCallsAfterSuppression = fetchCalls;
const sentResult = await sendEmail(email, {
  apiKey: "test-postmark-key",
  deliveryEnabled: true,
  fetchEmail: fakeFetch,
});
const suppressedOutput = formatSuppressedEmail(email);
const magicOutput = formatMagicSignInLink("http://localhost:3008/api/auth/callback?token=test");

const checks = [
  assertEqual(
    "email delivery defaults off when the gate is missing",
    isEmailDeliveryEnabled(),
    false,
  ),
  assertEqual(
    "email delivery accepts an explicit true value",
    isEmailDeliveryEnabled(" TRUE "),
    true,
  ),
  assertEqual("email delivery rejects non-true values", isEmailDeliveryEnabled("1"), false),
  assertEqual("suppressed email reports its status", suppressedResult.status, "suppressed"),
  assertEqual("suppressed email does not call Postmark", fetchCallsAfterSuppression, 0),
  assertEqual("suppressed email is logged once", logs.length, 1),
  assertIncludes("suppressed email identifies its recipient", suppressedOutput, email.to),
  assertIncludes("suppressed email identifies its subject", suppressedOutput, email.subject),
  assertIncludes("suppressed email includes its text body", suppressedOutput, email.text),
  assertEqual("enabled email reports its sent status", sentResult.status, "sent"),
  assertEqual("enabled email calls Postmark once", fetchCalls, 1),
  assertIncludes("magic-link output has a clear label", magicOutput, "MAGIC SIGN-IN LINK"),
  assertIncludes(
    "magic-link output includes the copyable URL",
    magicOutput,
    "http://localhost:3008/api/auth/callback?token=test",
  ),
  await expectReject(
    "enabled delivery requires a Postmark key",
    () => sendEmail(email, { apiKey: undefined, deliveryEnabled: true, fetchEmail: fakeFetch }),
    "POSTMARK_API_KEY",
  ),
];

console.log(JSON.stringify({ checks, status: "ok" }));
