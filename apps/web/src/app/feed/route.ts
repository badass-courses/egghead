const UPDATED_AT = "2026-06-07T00:00:00.000Z";

function rssXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>egghead</title>
    <link>https://egghead.io</link>
    <description>Standalone Egghead public content feed.</description>
    <lastBuildDate>${new Date(UPDATED_AT).toUTCString()}</lastBuildDate>
    <item>
      <title>Array Goodness</title>
      <link>https://egghead.io/courses/array-goodness-061118ff</link>
      <guid>https://egghead.io/courses/array-goodness-061118ff</guid>
      <pubDate>${new Date(UPDATED_AT).toUTCString()}</pubDate>
    </item>
  </channel>
</rss>
`;
}

export function GET() {
  return new Response(rssXml(), {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
    },
  });
}
