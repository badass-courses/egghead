"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@egghead/ui/button";

export function SignOutButton() {
  const { pending } = useFormStatus();

  return (
    <Button disabled={pending} size="sm" type="submit" variant="ghost">
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
