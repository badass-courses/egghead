import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { signOut } from "../../server/auth";

async function signOutOfEgghead() {
  "use server";

  await signOut({ redirectTo: "/" });
}

export default function LogoutPage() {
  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader
          description="End your current egghead session."
          eyebrow="Account"
          title="Sign out"
        />

        <form action={signOutOfEgghead} className="egghead-login-actions">
          <button className="egghead-login-button" type="submit">
            Sign out
          </button>
        </form>
      </Stack>
    </Container>
  );
}
