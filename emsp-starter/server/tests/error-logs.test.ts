import { afterEach, describe, expect, it, vi } from "vitest";
import { failed } from "@/lib/accounts/api";
import { AuthRequestError, logText } from "@/lib/server/log-error";
import { supabaseRest } from "@/lib/server/supabase-rest";

const KEY = "sb_secret_exampleKEYexample";
const EMAIL = "driver@example.test";

async function logged(status: number): Promise<string> {
  const rest = supabaseRest("https://x.supabase.test", KEY, async () =>
    Response.json({ message: `secret row ${EMAIL}` }, { status }),
  );
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await rest("GET", `emsp_locations?select=*&email=eq.${EMAIL}`);
  } catch (e) {
    failed(new Request("https://x.test/api/x"), "list", e);
  }
  return spy.mock.calls.map((c) => c.join(" ")).join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("route error logs", () => {
  it("names the table and status of a 404 (missing table), no key or values", async () => {
    const line = await logged(404);
    expect(line).toContain("emsp_locations");
    expect(line).toContain("HTTP 404");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain("select=");
  });

  it("names the table and status of a 401 (wrong key), no key or values", async () => {
    const line = await logged(401);
    expect(line).toContain("emsp_locations");
    expect(line).toContain("HTTP 401");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(EMAIL);
  });

  it("logs a Supabase Auth refusal's endpoint and status", () => {
    const e = new AuthRequestError(
      "Auth request failed: POST otp (HTTP 401)",
      401,
    );
    expect(logText(e)).toContain("POST otp (HTTP 401)");
  });

  it("logs any other error by name only", () => {
    expect(logText(new TypeError(`bad ${EMAIL} ${KEY}`))).toBe("TypeError");
    expect(logText("text")).toBe("unknown error");
  });
});
