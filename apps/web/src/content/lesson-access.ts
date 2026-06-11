export function lessonRequiresAccess(input: { courseLinked: boolean; freeForever: boolean }) {
  return input.courseLinked && !input.freeForever;
}
