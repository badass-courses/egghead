import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  acceptanceProblem,
  profileCreationProblem,
} from "../../src/lib/invites/invite-rules";
import { verifyMuxSignature } from "../../src/lib/mux-webhook-signature";
import { decideAccess } from "../../src/server/access-policy";
import { selfFetchHeaders } from "../../src/server/self-fetch";

const anon = { signedIn: false, roles: [], hasBearer: false };
const learner = { signedIn: true, roles: ["user"], hasBearer: false };
const contributor = {
  signedIn: true,
  roles: ["contributor"],
  hasBearer: false,
};
const admin = { signedIn: true, roles: ["admin"], hasBearer: false };
const bearer = { signedIn: false, roles: [], hasBearer: true };

describe("builder access gate (sec-20261121-008)", () => {
  it("closes pages and APIs to anyone without a contributor or admin role", () => {
    for (const who of [anon, learner]) {
      expect(decideAccess("/", who)).toBe("login");
      expect(decideAccess("/posts/some-lesson/edit", who)).toBe("login");
      expect(decideAccess("/admin/instructors/invite", who)).toBe("login");
      expect(decideAccess("/api/trpc/tags.createTag", who)).toBe("deny");
      expect(decideAccess("/api/trpc/users.updateProfile", who)).toBe("deny");
      expect(decideAccess("/api/uploads/signed-url", who)).toBe("deny");
      expect(decideAccess("/api/mux", who)).toBe("deny");
    }
  });

  it("lets editors through", () => {
    for (const who of [contributor, admin]) {
      expect(decideAccess("/posts/some-lesson/edit", who)).toBe("allow");
      expect(decideAccess("/api/trpc/tags.createTag", who)).toBe("allow");
      expect(decideAccess("/api/uploads/signed-url", who)).toBe("allow");
    }
  });

  it("keeps sign-in, invites and self-authenticating machine callers open", () => {
    for (const path of [
      "/login",
      "/check-your-email",
      "/api/auth/callback/egghead",
      "/invites/abc123",
      "/oauth/token",
      "/api/inngest",
      "/api/mux/webhook",
      "/api/coursebuilder/webhook/deepgram",
      "/api/uploadthing",
      "/api/cron",
      "/_next/static/chunk.js",
      "/favicon.ico",
    ]) {
      expect(decideAccess(path, anon), path).toBe("allow");
    }
  });

  it("does not open a route because its path ends in a file extension", () => {
    expect(decideAccess("/api/tags/some-post.js", anon)).toBe("deny");
    expect(decideAccess("/api/videos/abc.css", anon)).toBe("deny");
    expect(decideAccess("/api/posts.txt", anon)).toBe("deny");
    expect(decideAccess("/some-lesson.png", anon)).toBe("login");
    expect(decideAccess("/admin/x.map", anon)).toBe("login");
  });

  it("serves every public/ file without a session", () => {
    const dir = fileURLToPath(new URL("../../public/", import.meta.url));
    for (const name of readdirSync(dir)) {
      expect(decideAccess(`/${name}`, anon), name).toBe("allow");
    }
  });

  it("opens only the coursebuilder webhook, not the rest of its router", () => {
    for (const route of [
      "refund",
      "redeem",
      "checkout",
      "create-magic-link",
      "lookup",
      "transfer",
      "session",
      "purchases",
      "srt",
    ]) {
      expect(decideAccess(`/api/coursebuilder/${route}`, anon), route).toBe(
        "deny",
      );
    }
    expect(decideAccess("/api/coursebuilder/webhook/deepgram", anon)).toBe(
      "allow",
    );
  });

  it("refuses server-action calls from non-editors except on invite pages", () => {
    for (const path of [
      "/login",
      "/privacy",
      "/api/inngest",
      "/posts/x/edit",
      "/activate",
    ]) {
      expect(decideAccess(path, { ...anon, serverAction: true }), path).toBe(
        "deny",
      );
      expect(decideAccess(path, { ...learner, serverAction: true }), path).toBe(
        "deny",
      );
      expect(
        decideAccess(path, { ...contributor, serverAction: true }),
        path,
      ).toBe("allow");
    }
    expect(decideAccess("/invites/abc", { ...anon, serverAction: true })).toBe(
      "allow",
    );
  });

  it("does not let a lookalike path ride an exemption", () => {
    expect(decideAccess("/api/inngest-evil", anon)).toBe("deny");
    expect(decideAccess("/api/muxer", anon)).toBe("deny");
    expect(decideAccess("/loginx", anon)).toBe("login");
  });

  it("passes device-token API calls to routes that check the token", () => {
    expect(decideAccess("/api/posts", bearer)).toBe("allow");
    expect(decideAccess("/api/uploads/new", bearer)).toBe("allow");
    expect(decideAccess("/api/trpc/tags.createTag", bearer)).toBe("deny");
    expect(decideAccess("/posts/x/edit", bearer)).toBe("login");
    expect(decideAccess("/api/posts", { ...anon, preflight: true })).toBe(
      "allow",
    );
    expect(decideAccess("/api/trpc/x", { ...anon, preflight: true })).toBe(
      "deny",
    );
  });

  it("needs a session for device activation", () => {
    expect(decideAccess("/activate", anon)).toBe("login");
    expect(decideAccess("/activate", learner)).toBe("allow");
  });
});

describe("instructor invite chain (sec-20261121-007)", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  const fresh = {
    inviteState: "INITIATED" as const,
    inviteEmail: "Invited@Example.com",
    expiresAt: new Date("2026-11-25T00:00:00Z"),
  };

  it("accepts only the invited email, once, before expiry", () => {
    expect(acceptanceProblem(fresh, "invited@example.com ", now)).toBeNull();
    expect(
      acceptanceProblem(fresh, "attacker@example.com", now),
    ).not.toBeNull();
    expect(
      acceptanceProblem(
        { ...fresh, inviteState: "VERIFIED" },
        "invited@example.com",
        now,
      ),
    ).not.toBeNull();
    expect(
      acceptanceProblem(
        { ...fresh, expiresAt: new Date("2026-11-20T00:00:00Z") },
        "invited@example.com",
        now,
      ),
    ).not.toBeNull();
    expect(acceptanceProblem(null, "invited@example.com", now)).not.toBeNull();
  });

  it("creates a profile only from a verified invite accepted by the invited email", () => {
    const verified = {
      ...fresh,
      inviteState: "VERIFIED" as const,
      acceptedEmail: "invited@example.com",
    };
    expect(
      profileCreationProblem(verified, "invited@example.com", now),
    ).toBeNull();
    expect(
      profileCreationProblem(fresh, "invited@example.com", now),
    ).not.toBeNull();
    expect(
      profileCreationProblem(
        { ...verified, acceptedEmail: "attacker@example.com" },
        "invited@example.com",
        now,
      ),
    ).not.toBeNull();
    expect(
      profileCreationProblem(verified, "attacker@example.com", now),
    ).not.toBeNull();
  });

  it("restricts invite creation to admins and makes invite ids unguessable", () => {
    const action = read("src/app/admin/instructors/invite/actions.ts");
    expect(action).toMatch(/await requireAdmin\(\)/);
    const created = read("src/inngest/functions/instructor-invite-created.ts");
    const length = Number(
      created.match(/customAlphabet\([^,]+,\s*(\d+)\)/)?.[1],
    );
    expect(length).toBeGreaterThanOrEqual(20);
  });
});

describe("server self-fetch under Vercel protection", () => {
  const keys = [
    "VERCEL_AUTOMATION_BYPASS_SECRET",
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
  ] as const;
  const withEnv = (
    env: Partial<Record<(typeof keys)[number], string>>,
    fn: () => void,
  ) => {
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      fn();
    } finally {
      for (const k of keys) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  };
  const vercel = {
    VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-test",
    VERCEL_URL: "course-builder-egghead-abc123.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "builder.egghead.io",
  };

  it("sends the bypass secret to the deployment own hosts", () => {
    withEnv(vercel, () => {
      expect(
        selfFetchHeaders("https://builder.egghead.io/api/auth/csrf"),
      ).toEqual({
        "x-vercel-protection-bypass": "bypass-test",
      });
      expect(
        selfFetchHeaders(
          "https://course-builder-egghead-abc123.vercel.app/api/inngest",
        ),
      ).toEqual({
        "x-vercel-protection-bypass": "bypass-test",
      });
    });
  });

  it("never sends it to any other host, a bad URL, or without the secret", () => {
    withEnv(vercel, () => {
      expect(selfFetchHeaders("https://egghead.io/api/auth/csrf")).toEqual({});
      expect(
        selfFetchHeaders("https://builder.egghead.io.evil.example/x"),
      ).toEqual({});
      expect(
        selfFetchHeaders("https://evil.example/?u=builder.egghead.io"),
      ).toEqual({});
      expect(selfFetchHeaders("not a url")).toEqual({});
    });
    withEnv({ ...vercel, VERCEL_AUTOMATION_BYPASS_SECRET: undefined }, () => {
      expect(
        selfFetchHeaders("https://builder.egghead.io/api/auth/csrf"),
      ).toEqual({});
    });
  });

  it("only the login CSRF fetch and the cron Inngest refresh use it", () => {
    expect(read("src/app/(user)/login/actions.ts")).toMatch(
      /\.\.\.selfFetchHeaders\(env\.COURSEBUILDER_URL\)/,
    );
    expect(read("src/app/api/cron/route.ts")).toMatch(
      /headers: selfFetchHeaders\(/,
    );
  });
});

describe("Mux webhook signature", () => {
  const secret = "whsec_test";
  const body = '{"type":"video.asset.ready","object":{"id":"a"}}';
  const t = 1795200000;
  const sign = (b: string, ts = t) =>
    createHmac("sha256", secret).update(`${ts}.${b}`).digest("hex");

  it("accepts a valid signature and refuses forged, replayed or unsigned events", () => {
    expect(
      verifyMuxSignature({
        rawBody: body,
        header: `t=${t},v1=${sign(body)}`,
        secret,
        nowSeconds: t + 10,
      }),
    ).toBe(true);
    expect(
      verifyMuxSignature({
        rawBody: body.replace("ready", "errored"),
        header: `t=${t},v1=${sign(body)}`,
        secret,
        nowSeconds: t,
      }),
    ).toBe(false);
    expect(
      verifyMuxSignature({
        rawBody: body,
        header: `t=${t},v1=${sign(body)}`,
        secret,
        nowSeconds: t + 3600,
      }),
    ).toBe(false);
    expect(
      verifyMuxSignature({
        rawBody: body,
        header: null,
        secret,
        nowSeconds: t,
      }),
    ).toBe(false);
    expect(
      verifyMuxSignature({
        rawBody: body,
        header: `t=${t},v1=${sign(body)}`,
        secret: undefined,
        nowSeconds: t,
      }),
    ).toBe(false);
  });

  it("accepts any of several v1 values during a secret rotation", () => {
    const stale = "ab".repeat(32);
    expect(
      verifyMuxSignature({
        rawBody: body,
        header: `t=${t},v1=${stale},v1=${sign(body)}`,
        secret,
        nowSeconds: t,
      }),
    ).toBe(true);
    expect(
      verifyMuxSignature({
        rawBody: body,
        header: `t=${t},v1=${stale}`,
        secret,
        nowSeconds: t,
      }),
    ).toBe(false);
  });
});

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const read = (path: string) =>
  readFileSync(`${src}${path.replace(/^src\//, "")}`, "utf8");

/** The body of an exported function, from its declaration to the next export. */
const bodyOf = (text: string, name: string) => {
  const start = text.search(
    new RegExp(`export (async function|const) ${name}\\b`),
  );
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = text.slice(start + 1).search(/\nexport /);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
};

describe("client-reachable server actions check the caller before touching data", () => {
  const guarded: [string, string][] = [
    ["src/lib/posts/write.ts", "addTagToPost"],
    ["src/lib/posts/write.ts", "removeTagFromPost"],
    ["src/lib/posts/write.ts", "setPrimaryTagToPost"],
    ["src/lib/posts/playlists.ts", "removePostFromCoursePost"],
    ["src/lib/posts/playlists.ts", "addResourceToResource"],
    ["src/lib/posts/playlists.ts", "removeSection"],
    ["src/lib/posts/playlists.ts", "updateResourcePositions"],
    ["src/lib/transcript-query.ts", "updateTranscript"],
    ["src/transcript-editor/actions.ts", "updateTranscript"],
  ];

  for (const [file, name] of guarded) {
    it(`${name} in ${file}`, () => {
      const body = bodyOf(read(file), name);
      const guard = body.search(
        /requireCanManageResource\(|requireContentEditor\(|requireAdmin\(|getServerAuthSession\(/,
      );
      const firstData = body.search(
        /\b(db|trx|courseBuilderAdapter)\.|eggheadPgQuery\(|inngest\.send\(/,
      );
      expect(guard, "guard present").toBeGreaterThan(-1);
      expect(firstData === -1 || guard < firstData, "guard before data").toBe(
        true,
      );
    });
  }

  it("removeSection only removes sections", () => {
    expect(bodyOf(read("src/lib/posts/playlists.ts"), "removeSection")).toMatch(
      /resource\.type !== 'section'/,
    );
  });

  it("profile edits check ownership and tag creation needs an editor", () => {
    expect(read("src/trpc/api/routers/users.ts")).toMatch(
      /signedInUser\.id !== input\.userId/,
    );
    expect(read("src/trpc/api/routers/tags.ts")).toMatch(
      /ability\.cannot\('create', 'Content'\)/,
    );
  });

  it("cron refuses without a configured secret", () => {
    expect(read("src/app/api/cron/route.ts")).toMatch(/if \(!secret \|\| /);
  });

  it("upload URL minting and the Mux direct upload require an editor", () => {
    expect(read("src/app/api/uploads/signed-url/route.ts")).toMatch(
      /isContentEditorRequest\(request\)/,
    );
    expect(read("src/app/api/mux/route.ts")).toMatch(
      /isContentEditorRequest\(req\)/,
    );
    expect(read("src/app/api/mux/webhook/route.ts")).toMatch(
      /verifyMuxSignature\(/,
    );
  });
});
