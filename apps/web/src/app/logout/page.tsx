import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import { signOut } from "../../server/auth";

async function signOutOfEgghead() {
  "use server";

  await signOut({ redirectTo: "/" });
}

export default function LogoutPage() {
  return (
    <Container as="main" size="narrow">
      <SectionHeader
        description="End your current egghead session."
        eyebrow="Account"
        title="Sign out"
      />

      <form action={signOutOfEgghead} className="grid max-w-xs gap-3">
        <Button type="submit" variant="ghost">
          Sign out
        </Button>
      </form>
    </Container>
  );
}
