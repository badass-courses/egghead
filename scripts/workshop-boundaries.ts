import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const failures: string[] = [];
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}
function inspect(path: string, allowed: (specifier: string) => boolean, allowCache = true) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (!allowed(specifier))
        failures.push(`${relative(process.cwd(), path)} imports forbidden dependency ${specifier}`);
    }
    if (
      !allowCache &&
      ts.isExpressionStatement(node) &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === "use cache"
    ) {
      failures.push(`${path} caches time-dependent workshop output`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      failures.push(`${path} uses an unchecked dynamic import`);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const path of files("packages/workshops/src"))
  inspect(
    path,
    (specifier) =>
      [
        "effect/Context",
        "effect/DateTime",
        "effect/Effect",
        "effect/Layer",
        "effect/Option",
        "effect/Schema",
      ].includes(specifier) || /^\.\/[^/]+$/.test(specifier),
  );
for (const path of existsSync("packages/workshop-catalog/src")
  ? files("packages/workshop-catalog/src")
  : [])
  inspect(
    path,
    (specifier) =>
      specifier.startsWith("effect/") ||
      specifier === "mysql2/promise" ||
      specifier.startsWith("@egghead/workshops/") ||
      /^\.\/[^/]+$/.test(specifier),
  );
for (const path of [
  ...files("apps/web/src/app/workshops"),
  "apps/web/src/content/workshop-page.tsx",
  "apps/web/src/workshops/read.ts",
]) {
  inspect(
    path,
    (specifier) =>
      !specifier.includes("db/") &&
      !specifier.includes("workshop-catalog") &&
      !specifier.includes("mysql") &&
      !specifier.includes("coursebuilder"),
    false,
  );
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(
  JSON.stringify({
    ok: true,
    boundaries: [
      "domain has no providers or Next",
      "provider stays behind catalog",
      "views cannot cache computed offers or registration",
    ],
  }),
);
