import { describe, expect, it } from "vitest";
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
