import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = join(root, ".local/course-builder");
const command = process.argv[2] ?? "status";
const packages = [
  "core",
  "adapter-drizzle",
  "commerce",
  "server",
  "next",
  "video-processing",
  "email",
  "utils",
  "ui",
];
const packageDirectory = (name) => (name === "utils" ? "coursebuilder-utils" : name);
const peerLink = join(upstream, "packages/adapter-drizzle/node_modules/drizzle-orm");
const peerBackup = join(root, ".local/coursebuilder-drizzle-peer-original.txt");

function run(cwd, args) {
  const result = spawnSync("corepack", ["pnpm", ...args], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed`);
}

function alignPeer() {
  const target = realpathSync(join(root, "apps/web/node_modules/drizzle-orm"));
  if (!lstatSync(peerLink).isSymbolicLink()) {
    throw new Error("Expected a pnpm symlink for the adapter's Drizzle peer");
  }
  if (!existsSync(peerBackup)) writeFileSync(peerBackup, readlinkSync(peerLink));
  unlinkSync(peerLink);
  symlinkSync(target, peerLink);
  const savedPath = join(root, ".local/coursebuilder-shared-peers.json");
  const saved = existsSync(savedPath) ? JSON.parse(readFileSync(savedPath, "utf8")) : {};
  const modules = [
    ...readdirSync(join(upstream, "packages")).map((pkg) =>
      join(upstream, "packages", pkg, "node_modules"),
    ),
    ...readdirSync(join(upstream, "node_modules/.pnpm")).map((pkg) =>
      join(upstream, "node_modules/.pnpm", pkg, "node_modules"),
    ),
  ];
  for (const peer of [
    "next",
    "react",
    "react-dom",
    "react-hook-form",
    "@internationalized/date",
    "@codemirror/view",
  ]) {
    const peerTarget = realpathSync(join(root, "apps/builder-egghead/node_modules", peer));
    for (const directory of modules) {
      const link = join(directory, peer);
      if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) continue;
      if (!(link in saved)) saved[link] = readlinkSync(link);
      unlinkSync(link);
      symlinkSync(peerTarget, link);
    }
  }
  writeFileSync(savedPath, JSON.stringify(saved, null, 2));
  for (const app of ["web", "builder-egghead"]) {
    const cache = join(root, "apps", app, "tsconfig.tsbuildinfo");
    if (existsSync(cache)) unlinkSync(cache);
  }
}

if (!existsSync(join(upstream, ".git"))) {
  throw new Error(
    "Expected the upstream Git checkout at .local/course-builder; see apps/builder-egghead/plans/local-coursebuilder-testing.md",
  );
}

switch (command) {
  case "build":
    run(upstream, [
      "--filter",
      "@coursebuilder/next...",
      "--filter",
      "@coursebuilder/adapter-drizzle...",
      "--filter",
      "@coursebuilder/ui...",
      "-r",
      "build",
    ]);
    break;
  case "link":
    for (const name of packages) {
      if (!existsSync(join(upstream, "packages", packageDirectory(name), "package.json"))) {
        throw new Error(`Missing local package: ${name}`);
      }
    }
    run(root, [
      "link",
      ...packages.map((name) => `./.local/course-builder/packages/${packageDirectory(name)}`),
    ]);
    run(root, ["install", "--no-frozen-lockfile"]);
    run(root, ["exec", "oxfmt", "--write", "package.json", "pnpm-workspace.yaml"]);
    alignPeer();
    break;
  case "unlink": {
    const packagePath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    for (const name of packages) {
      const key = `@coursebuilder/${name}`;
      if (
        manifest.dependencies?.[key] ===
        `link:.local/course-builder/packages/${packageDirectory(name)}`
      ) {
        delete manifest.dependencies[key];
      }
    }
    if (manifest.dependencies && Object.keys(manifest.dependencies).length === 0) {
      delete manifest.dependencies;
    }
    writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
    const workspacePath = join(root, "pnpm-workspace.yaml");
    const workspace = readFileSync(workspacePath, "utf8");
    writeFileSync(
      workspacePath,
      workspace
        .split("\n")
        .filter(
          (line) =>
            !packages.some(
              (name) =>
                line.includes(`@coursebuilder/${name}`) &&
                line.includes(`link:.local/course-builder/packages/${packageDirectory(name)}`),
            ),
        )
        .join("\n"),
    );
    run(root, ["install", "--no-frozen-lockfile"]);
    run(root, ["exec", "oxfmt", "--write", "package.json", "pnpm-workspace.yaml"]);
    const savedPath = join(root, ".local/coursebuilder-shared-peers.json");
    if (existsSync(savedPath)) {
      const saved = JSON.parse(readFileSync(savedPath, "utf8"));
      for (const [link, target] of Object.entries(saved)) {
        if (!existsSync(link)) continue;
        if (!lstatSync(link).isSymbolicLink()) throw new Error(`Unexpected peer path: ${link}`);
        unlinkSync(link);
        symlinkSync(String(target), link);
      }
      unlinkSync(savedPath);
    }
    if (existsSync(peerBackup)) {
      if (!lstatSync(peerLink).isSymbolicLink()) throw new Error("Unexpected Drizzle peer path");
      unlinkSync(peerLink);
      symlinkSync(readFileSync(peerBackup, "utf8"), peerLink);
      unlinkSync(peerBackup);
    }
    break;
  }
  case "status":
    for (const app of ["web", "builder-egghead"]) {
      for (const name of packages) {
        if (!existsSync(join(root, "apps", app, "node_modules/@coursebuilder", name))) continue;
        console.log(
          `${app}: @coursebuilder/${name} → ${realpathSync(join(root, "apps", app, "node_modules/@coursebuilder", name))}`,
        );
      }
    }
    break;
  default:
    throw new Error("Usage: pnpm coursebuilder:local [build|link|unlink|status]");
}
