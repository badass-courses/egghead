/**
 * The sources a learner's own lesson toggle stamps on a progress row, through
 * `setLessonCompletion`. The action validates against this list, and the Rails
 * progress import treats exactly these as explicit learner decisions, so a new
 * UI path cannot be added without the import seeing it.
 *
 * Kept out of the "use server" action module, which may only export async
 * functions.
 */
export const LESSON_PROGRESS_SOURCES = ["lesson_player_ended", "lesson_progress_control"] as const;

export type LessonProgressSource = (typeof LESSON_PROGRESS_SOURCES)[number];
