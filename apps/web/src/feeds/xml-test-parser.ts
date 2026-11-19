// Strict, tiny XML well-formedness parser used only by the feed tests. It
// covers the subset renderRss emits (prolog, elements, attributes, text,
// predefined and numeric entities) and throws on anything malformed, so the
// tests do not need a new XML dependency.

export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const PREDEFINED: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decode(raw: string, where: string) {
  if (raw.replace(ENTITY, "").includes("&")) throw new Error(`Bare & in ${where}`);
  if (raw.includes("<")) throw new Error(`Raw < in ${where}`);
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) {
      throw new Error(`Control character U+${code.toString(16)} in ${where}`);
    }
  }
  return raw.replace(ENTITY, (entity) => {
    if (entity.startsWith("&#x"))
      return String.fromCodePoint(Number.parseInt(entity.slice(3, -1), 16));
    if (entity.startsWith("&#")) return String.fromCodePoint(Number(entity.slice(2, -1)));
    return PREDEFINED[entity] ?? entity;
  });
}

function parseAttrs(source: string, tag: string) {
  const attrs: Record<string, string> = {};
  const pattern = /\s+([^\s=]+)="([^"]*)"/gy;
  let consumed = 0;
  for (const match of source.matchAll(pattern)) {
    const [whole, name = "", value = ""] = match;
    if (!NAME.test(name)) throw new Error(`Bad attribute name ${name} on <${tag}>`);
    if (name in attrs) throw new Error(`Duplicate attribute ${name} on <${tag}>`);
    attrs[name] = decode(value, `attribute ${name} of <${tag}>`);
    consumed += whole.length;
  }
  if (source.slice(consumed).trim()) throw new Error(`Malformed attributes on <${tag}>: ${source}`);
  return attrs;
}

export function parseXml(xml: string): XmlNode {
  let rest = xml;
  if (!rest.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    throw new Error("Missing UTF-8 XML declaration");
  }
  rest = rest.slice(rest.indexOf("?>") + 2);

  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];

  while (rest.length > 0) {
    const current = stack.at(-1);
    if (!current) throw new Error("Unbalanced document");
    const lt = rest.indexOf("<");
    const text = lt === -1 ? rest : rest.slice(0, lt);
    if (text) {
      const decoded = decode(text, `text of <${current.name}>`);
      if (current === root && decoded.trim()) throw new Error("Text outside the root element");
      current.text += decoded;
    }
    if (lt === -1) break;
    rest = rest.slice(lt);

    const gt = rest.indexOf(">");
    if (gt === -1) throw new Error("Unterminated tag");
    const tag = rest.slice(1, gt);
    rest = rest.slice(gt + 1);

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (current.name !== name) throw new Error(`Expected </${current.name}>, got </${name}>`);
      stack.pop();
      continue;
    }

    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameEnd = body.search(/\s|$/);
    const name = body.slice(0, nameEnd);
    if (!NAME.test(name)) throw new Error(`Bad element name <${name}>`);
    if (current === root && root.children.length > 0) throw new Error("More than one root element");

    const node: XmlNode = {
      name,
      attrs: parseAttrs(body.slice(nameEnd), name),
      children: [],
      text: "",
    };
    current.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) throw new Error(`Unclosed <${stack.at(-1)?.name ?? "?"}>`);
  const [documentElement] = root.children;
  if (!documentElement) throw new Error("Empty document");
  assertNamespacesDeclared(documentElement, documentElement.attrs);
  return documentElement;
}

function assertNamespacesDeclared(node: XmlNode, rootAttrs: Record<string, string>) {
  const prefixes = [node.name, ...Object.keys(node.attrs)]
    .filter((name) => name.includes(":") && !name.startsWith("xmlns:"))
    .map((name) => name.split(":")[0]);
  for (const prefix of prefixes) {
    if (!rootAttrs[`xmlns:${prefix}`]) throw new Error(`Undeclared namespace prefix ${prefix}`);
  }
  for (const childNode of node.children) assertNamespacesDeclared(childNode, rootAttrs);
}

export function child(node: XmlNode, name: string) {
  return node.children.find((candidate) => candidate.name === name);
}

export function children(node: XmlNode, name: string) {
  return node.children.filter((candidate) => candidate.name === name);
}

export function childText(node: XmlNode, name: string) {
  return child(node, name)?.text;
}
