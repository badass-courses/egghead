import { Container } from "@egghead/ui/container";
import {
  ResourceListCard,
  ResourceListHeader,
  ResourceListViewport,
} from "@egghead/ui/resource-list";
import { cn } from "@egghead/ui/utils";

const curriculumRows = [
  { id: "first", width: "w-3/4" },
  { id: "second", width: "w-4/5" },
  { id: "third", width: "w-2/3" },
  { id: "fourth", width: "w-5/6" },
  { id: "fifth", width: "w-3/5" },
  { id: "sixth", width: "w-3/4" },
] as const;

function SkeletonLine({ className }: { className: string }) {
  return <span className={cn("block rounded-full bg-border-strong/70", className)} />;
}

function LessonCurriculumSkeleton() {
  return (
    <div className="min-h-80 min-[960px]:min-h-0">
      <ResourceListCard className="h-full min-[960px]:rounded-l-none min-[960px]:border-l-0">
        <ResourceListHeader>
          <SkeletonLine className="h-2.5 w-14 bg-rust/35" />
          <SkeletonLine className="h-5 w-4/5" />
          <SkeletonLine className="h-3 w-28" />
        </ResourceListHeader>
        <ResourceListViewport className="px-3.5 py-1">
          <div className="grid gap-1">
            {curriculumRows.map((row) => (
              <div className="flex items-center gap-3 px-2.5 py-2" key={row.id}>
                <span className="size-7 shrink-0 rounded-full border border-border-strong bg-well shadow-well" />
                <SkeletonLine className={cn("h-3.5", row.width)} />
              </div>
            ))}
          </div>
        </ResourceListViewport>
      </ResourceListCard>
    </div>
  );
}

export default function CollectionEntryLoading() {
  return (
    <Container
      aria-busy="true"
      aria-labelledby="lesson-loading-status"
      as="main"
      className="pt-4"
      size="wide"
    >
      <output className="sr-only" id="lesson-loading-status">
        Loading lesson
      </output>

      <div aria-hidden className="flex animate-pulse flex-col gap-flow motion-reduce:animate-none">
        <div className="grid gap-flow">
          <div className="grid gap-8 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] min-[960px]:gap-x-0 min-[960px]:gap-y-flow">
            <div className="egghead-lesson-player-cell min-w-0">
              <div className="egghead-video-placeholder" />
            </div>
            <LessonCurriculumSkeleton />
          </div>

          <header className="grid gap-3">
            <SkeletonLine className="h-3 w-28 bg-rust/35" />
            <SkeletonLine className="h-10 w-full max-w-2xl" />
            <div className="grid max-w-prose gap-2">
              <SkeletonLine className="h-4 w-full" />
              <SkeletonLine className="h-4 w-2/3" />
            </div>
          </header>
        </div>

        <div className="flex flex-wrap gap-x-10 gap-y-3">
          <div className="grid w-20 gap-2">
            <SkeletonLine className="h-2.5 w-14 bg-rust/35" />
            <SkeletonLine className="h-7 w-20" />
          </div>
          <div className="grid w-20 gap-2">
            <SkeletonLine className="h-2.5 w-12 bg-rust/35" />
            <SkeletonLine className="h-7 w-16" />
          </div>
          <div className="grid w-28 gap-2">
            <SkeletonLine className="h-2.5 w-20 bg-rust/35" />
            <SkeletonLine className="h-7 w-28" />
          </div>
        </div>

        <div className="grid max-w-prose gap-3 border-t border-border pt-flow">
          <SkeletonLine className="h-4 w-full" />
          <SkeletonLine className="h-4 w-3/4" />
        </div>

        <div className="grid h-80 gap-5 rounded-2xl border border-border p-7">
          <SkeletonLine className="h-6 w-44" />
          <div className="grid content-start gap-3 border-t border-border pt-6">
            <SkeletonLine className="h-4 w-full" />
            <SkeletonLine className="h-4 w-11/12" />
            <SkeletonLine className="h-4 w-4/5" />
            <SkeletonLine className="h-4 w-5/6" />
          </div>
        </div>
      </div>
    </Container>
  );
}
