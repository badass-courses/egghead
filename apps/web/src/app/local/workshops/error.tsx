"use client";

export default function WorkshopPreviewError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-prose px-6 py-16">
      <h1 className="text-3xl font-bold">Workshop preview unavailable</h1>
      <p className="my-6">
        Check that the local Workshop MCP server is running and its device token is valid.
      </p>
      <button className="underline" onClick={reset} type="button">
        Try again
      </button>
    </main>
  );
}
