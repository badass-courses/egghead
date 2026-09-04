import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Profile unavailable | egghead",
  robots: { index: false, follow: false },
};

// Public profile and activity sharing are deferred, including metadata reads.
export default function PublicProfilePage() {
  notFound();
}
