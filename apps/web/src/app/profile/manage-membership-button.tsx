"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@egghead/ui/button";

export function ManageMembershipButton() {
  const { pending } = useFormStatus();

  return (
    <Button className="w-full" disabled={pending} type="submit" variant="ghost">
      {pending ? "Opening Stripe…" : "Manage Membership"}
    </Button>
  );
}
