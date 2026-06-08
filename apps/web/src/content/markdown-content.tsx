import ReactMarkdown from "react-markdown";

export async function MarkdownContent({
  children,
  label = "Content",
}: {
  children: string | null;
  label?: string;
}) {
  "use cache";

  if (!children) return null;

  return (
    <section aria-label={label} className="egghead-prose egghead-markdown">
      <ReactMarkdown>{children}</ReactMarkdown>
    </section>
  );
}
