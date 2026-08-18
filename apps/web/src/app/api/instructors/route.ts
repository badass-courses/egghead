import { searchInstructorsByName, topSearchInstructors } from "../../../content/instructors";

export async function GET(request: Request) {
  const term = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const instructors = term ? await searchInstructorsByName(term) : await topSearchInstructors();

  return Response.json({ instructors });
}
