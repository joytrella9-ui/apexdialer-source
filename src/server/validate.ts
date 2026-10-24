import { HttpError } from "./actor";

type Parsed<T> = { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };

export function parseInput<T>(schema: { safeParse: (input: unknown) => Parsed<T> }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(result.error.issues.map((issue) => issue.message).join(" "), 400);
  }
  return result.data;
}
