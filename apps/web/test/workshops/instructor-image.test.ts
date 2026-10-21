import { expect, it } from "vitest";
import { getImageProps } from "next/image";
import { workshopInstructorImage } from "../../src/workshops/instructor-image";

it.each([
  undefined,
  "https://[",
  "http://example.com/portrait.jpg",
  "https://user:password@example.com/portrait.jpg",
])("omits an invalid or unsupported portrait URL: %s", (value) =>
  expect(workshopInstructorImage(value)).toBeNull(),
);

it("renders an instructor's own HTTPS host without the optimizer allowlist", () => {
  const url = "https://instructor.example/portrait.jpg";
  const image = workshopInstructorImage(url);
  expect(image).not.toBeNull();
  if (!image) throw new Error("Expected external portrait props");
  const { props } = getImageProps({ ...image, width: 80, height: 80, alt: "Instructor" });
  expect(props.src).toBe(url);
  expect(props.srcSet).toBeUndefined();
});
