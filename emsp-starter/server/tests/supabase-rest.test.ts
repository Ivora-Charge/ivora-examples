import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "@/lib/server/config";
import { supabaseRequest } from "@/lib/server/supabase-rest";

async function headersSentWith(key: string): Promise<Record<string, string>> {
  let sent: Record<string, string> = {};
  const request = supabaseRequest(
    "https://example.supabase.co",
    key,
    async (_url, init) => {
      sent = init?.headers as Record<string, string>;
      return new Response("[]", { status: 200 });
    },
  );
  await request("GET", "ocpi_tokens?select=id");
  return sent;
}

describe("supabaseRequest key formats", () => {
  it("sends a legacy JWT service_role key as apikey and Bearer", async () => {
    const key = "aaa.bbb.ccc";
    const sent = await headersSentWith(key);
    expect(sent.apikey).toBe(key);
    expect(sent.Authorization).toBe(`Bearer ${key}`);
  });

  it("sends an sb_secret_ key as apikey only", async () => {
    const key = "sb_secret_exampleexample";
    const sent = await headersSentWith(key);
    expect(sent.apikey).toBe(key);
    expect(sent.Authorization).toBeUndefined();
  });
});

describe("the configured server key, under either name", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("sends SUPABASE_SECRET_KEY's sb_secret_ key as apikey only", async () => {
    process.env.SUPABASE_SECRET_KEY = "sb_secret_exampleexample";
    const sent = await headersSentWith(config.supabaseServiceRoleKey);
    expect(sent.apikey).toBe("sb_secret_exampleexample");
    expect(sent.Authorization).toBeUndefined();
  });

  it("sends our own name's legacy key when both are set", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "aaa.bbb.ccc";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_exampleexample";
    const sent = await headersSentWith(config.supabaseServiceRoleKey);
    expect(sent.apikey).toBe("aaa.bbb.ccc");
    expect(sent.Authorization).toBe("Bearer aaa.bbb.ccc");
  });
});
