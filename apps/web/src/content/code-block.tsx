import { isValidElement, type ComponentPropsWithoutRef } from "react";
import { codeToHtml } from "shiki";

import { CopyCodeButton } from "./copy-code-button";
import { eggheadCodeDark, eggheadCodeLight } from "./egghead-code-theme";

const THEMES = { dark: eggheadCodeDark, light: eggheadCodeLight };

/* Shell-ish languages render as a mac terminal window. */
const TERMINAL_LANGS = new Set([
  "bash",
  "console",
  "sh",
  "shell",
  "shellscript",
  "shellsession",
  "terminal",
  "zsh",
]);

async function highlight(code: string, lang: string) {
  return codeToHtml(code, {
    defaultColor: "light",
    lang,
    themes: THEMES,
  });
}

export async function CodeBlock({
  className,
  code,
}: {
  className?: string | undefined;
  code: string;
}) {
  const lang = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "text";
  const isTerminal = TERMINAL_LANGS.has(lang.toLowerCase());
  const trimmed = code.replace(/\n$/, "");
  const html = await highlight(trimmed, lang === "terminal" ? "bash" : lang).catch(() =>
    highlight(trimmed, "text"),
  );

  return (
    <div className="egghead-code" data-terminal={isTerminal ? "" : undefined}>
      {isTerminal ? (
        <div className="egghead-code-bar">
          <span aria-hidden className="egghead-code-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="egghead-code-bar-title">Terminal</span>
          <CopyCodeButton code={trimmed} />
        </div>
      ) : (
        <CopyCodeButton code={trimmed} />
      )}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/* react-markdown runs synchronously, so Shiki can't sit in its plugin
   chain — instead this replaces <pre> and defers to the async CodeBlock
   server component. Inline code keeps the default renderer. */
export function MarkdownPre({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  if (isValidElement(children)) {
    const codeProps: unknown = children.props;

    if (
      codeProps !== null &&
      typeof codeProps === "object" &&
      "children" in codeProps &&
      typeof codeProps.children === "string"
    ) {
      const className =
        "className" in codeProps && typeof codeProps.className === "string"
          ? codeProps.className
          : undefined;

      return <CodeBlock className={className} code={codeProps.children} />;
    }
  }

  return <pre {...props}>{children}</pre>;
}
