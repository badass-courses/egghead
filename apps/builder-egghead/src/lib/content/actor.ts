import { subject } from "@casl/ability";
import { ContentActor } from "@egghead/core/content";
import type { authenticateDevice } from "@/server/device-identity";

export function contentActor(
  identity: Awaited<ReturnType<typeof authenticateDevice>>,
  actorLabel: string | null,
) {
  if (!identity || !actorLabel || !/^[a-zA-Z0-9][a-zA-Z0-9 ._/-]{0,99}$/.test(actorLabel))
    return null;
  const { user, ability, tokenId } = identity;
  if (!ability.can("create", "Content")) return null;
  return ContentActor.of({
    userId: user.id,
    actorLabel,
    tokenId,
    canCreate: ability.can("create", "Content"),
    canManageAll: ability.can("manage", "all"),
    canRead: (post) => ability.can("read", subject("Content", post)),
    canManage: (post) => ability.can("manage", subject("Content", post)),
  });
}
