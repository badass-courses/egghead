// Rails #5361 disabled these credentials. Do not read or forward them.
export function retiredMemberFeed() {
  return new Response(null, {
    status: 410,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
