// Minimal RSS 2.0 writer with the iTunes and Media RSS namespaces Rails used.
// Pure string building so feed output is deterministic and testable.

export const ITUNES_NAMESPACE = "http://www.itunes.com/dtds/podcast-1.0.dtd";
export const MEDIA_NAMESPACE = "http://search.yahoo.com/mrss/";
export const CONTENT_NAMESPACE = "http://purl.org/rss/1.0/modules/content/";
export const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";

export type RssEnclosure = {
  url: string;
  length: number;
  type: string;
};

export type RssItunesItem = {
  author: string;
  subtitle: string;
  summary: string;
  explicit: string;
  /** Seconds as a string, or null when unknown (the element is then omitted). */
  duration: string | null;
};

export type RssItem = {
  title: string;
  description: string;
  link: string;
  guid: string;
  pubDate: string | null;
  enclosure?: RssEnclosure | null;
  /** <content:encoded>, as the `feed` package wrote it for egghead-next feeds. */
  contentEncoded?: string | null;
  itunes?: RssItunesItem;
};

export type RssItunesCategory = {
  text: string;
  children: readonly string[];
};

export type RssItunesChannel = {
  author: string;
  keywords: string;
  explicit: string;
  image: string | null;
  ownerName: string;
  ownerEmail: string;
  block: string;
  categories: readonly RssItunesCategory[];
};

export type RssChannel = {
  title: string;
  link: string;
  description: string;
  language?: string;
  pubDate?: string | null;
  lastBuildDate?: string | null;
  docs?: string;
  generator?: string;
  image?: { url: string; title: string; link: string };
  copyright?: string;
  itunes?: RssItunesChannel;
  items: readonly RssItem[];
};

// XML 1.0 forbids most C0 control characters even when escaped. Legacy
// summaries sometimes carry them, and one stray byte breaks every reader.
function isXmlChar(codePoint: number) {
  if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd) return true;
  if (codePoint < 0x20) return false;
  return codePoint !== 0xfffe && codePoint !== 0xffff;
}

function stripInvalidXmlChars(value: string) {
  let result = "";
  for (const char of value) {
    if (isXmlChar(char.codePointAt(0) ?? 0)) result += char;
  }
  return result;
}

export function escapeXml(value: string): string {
  return stripInvalidXmlChars(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function element(name: string, value: string, indent: string) {
  return `${indent}<${name}>${escapeXml(value)}</${name}>`;
}

function isBlank(value: string | null | undefined): value is null | undefined {
  return value == null || stripInvalidXmlChars(value).trim() === "";
}

/**
 * Never emit an empty element: an empty <pubDate> or <itunes:duration> is
 * invalid, and empty descriptive tags degrade podcast directories.
 */
function optionalElement(name: string, value: string | null | undefined, indent: string) {
  return isBlank(value) ? [] : [element(name, value, indent)];
}

/** Required elements fall back to a non-empty value instead of going empty. */
function requiredElement(name: string, value: string, fallback: string, indent: string) {
  return element(name, isBlank(value) ? fallback : value, indent);
}

function itunesChannelLines(itunes: RssItunesChannel, indent: string): string[] {
  const lines = [
    ...optionalElement("itunes:author", itunes.author, indent),
    ...optionalElement("itunes:keywords", itunes.keywords, indent),
    ...optionalElement("itunes:explicit", itunes.explicit, indent),
  ];

  if (!isBlank(itunes.image)) {
    lines.push(`${indent}<itunes:image href="${escapeXml(itunes.image)}"/>`);
  }

  lines.push(
    `${indent}<itunes:owner>`,
    ...optionalElement("itunes:name", itunes.ownerName, `${indent}  `),
    ...optionalElement("itunes:email", itunes.ownerEmail, `${indent}  `),
    `${indent}</itunes:owner>`,
    ...optionalElement("itunes:block", itunes.block, indent),
  );

  for (const category of itunes.categories) {
    lines.push(`${indent}<itunes:category text="${escapeXml(category.text)}">`);
    for (const child of category.children) {
      lines.push(`${indent}  <itunes:category text="${escapeXml(child)}"/>`);
    }
    lines.push(`${indent}</itunes:category>`);
  }

  return lines;
}

function itemLines(item: RssItem, indent: string): string[] {
  const inner = `${indent}  `;
  const lines = [
    `${indent}<item>`,
    requiredElement("title", item.title, item.guid, inner),
    ...optionalElement("description", item.description, inner),
    ...optionalElement("pubDate", item.pubDate, inner),
  ];

  if (item.enclosure) {
    const length = Math.max(0, Math.trunc(item.enclosure.length));
    lines.push(
      `${inner}<enclosure url="${escapeXml(item.enclosure.url)}" length="${length}" type="${escapeXml(item.enclosure.type)}"/>`,
    );
  }

  lines.push(
    element("link", item.link, inner),
    // Rails GUIDs are permalinks, so isPermaLink stays at its default (true).
    element("guid", item.guid, inner),
    ...optionalElement("content:encoded", item.contentEncoded, inner),
  );

  if (item.itunes) {
    lines.push(
      ...optionalElement("itunes:author", item.itunes.author, inner),
      ...optionalElement("itunes:subtitle", item.itunes.subtitle, inner),
      ...optionalElement("itunes:summary", item.itunes.summary, inner),
      ...optionalElement("itunes:explicit", item.itunes.explicit, inner),
      ...optionalElement("itunes:duration", item.itunes.duration, inner),
    );
  }

  lines.push(`${indent}</item>`);
  return lines;
}

export function renderRss(channel: RssChannel): string {
  const usesContent = channel.items.some((item) => !isBlank(item.contentEncoded));
  const namespaces = [
    channel.itunes ? ` xmlns:itunes="${ITUNES_NAMESPACE}" xmlns:media="${MEDIA_NAMESPACE}"` : "",
    usesContent ? ` xmlns:dc="${DC_NAMESPACE}" xmlns:content="${CONTENT_NAMESPACE}"` : "",
  ].join("");
  const indent = "    ";
  const image = channel.image
    ? [
        `${indent}<image>`,
        element("title", channel.image.title, `${indent}  `),
        element("url", channel.image.url, `${indent}  `),
        element("link", channel.image.link, `${indent}  `),
        `${indent}</image>`,
      ]
    : [];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0"${namespaces}>`,
    "  <channel>",
    requiredElement("title", channel.title, "egghead.io", indent),
    element("link", channel.link, indent),
    // RSS 2.0 requires a channel description; fall back to the title.
    requiredElement("description", channel.description, channel.title || "egghead.io", indent),
    ...optionalElement("language", channel.language, indent),
    ...optionalElement("pubDate", channel.pubDate, indent),
    ...optionalElement("lastBuildDate", channel.lastBuildDate, indent),
    ...optionalElement("docs", channel.docs, indent),
    ...optionalElement("generator", channel.generator, indent),
    ...image,
    ...optionalElement("copyright", channel.copyright, indent),
    ...(channel.itunes ? itunesChannelLines(channel.itunes, indent) : []),
    ...channel.items.flatMap((item) => itemLines(item, indent)),
    "  </channel>",
    "</rss>",
  ];

  return `${lines.join("\n")}\n`;
}
