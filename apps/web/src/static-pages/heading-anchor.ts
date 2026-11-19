const HEADING_ANCHOR = /^(.*?)\s*\{#([a-z0-9-]+)\}$/;

// Legacy FAQ links use fragment ids such as /faq#pay-invoice. The copied
// markdown carries them as "### Question {#id}".
export function headingAnchor(text: string): { text: string; id: string | undefined } {
  const match = HEADING_ANCHOR.exec(text);
  if (!match) return { text, id: undefined };
  return { text: match[1] ?? text, id: match[2] };
}
