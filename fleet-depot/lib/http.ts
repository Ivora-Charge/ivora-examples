import { describeError } from "./ivora";

export const json = (data: unknown, status = 200) =>
  Response.json(data, { status });
export const fail = (e: unknown, status = 400) =>
  json({ error: describeError(e) }, status);
