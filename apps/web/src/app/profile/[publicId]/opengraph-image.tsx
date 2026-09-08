import { notFound } from "next/navigation";

// No identity, avatar, or activity reads while public sharing is deferred.
export default function OpenGraphImage() {
  notFound();
}
