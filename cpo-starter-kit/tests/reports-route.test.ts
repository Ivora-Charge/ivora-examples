import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIvoraForTests } from "@/lib/server/ivora";
import { resetDemoCheckoutForTests } from "@/lib/server/checkout/demo-cookie";
import { resetDemoLiveForTests } from "@/lib/server/live/demo-cookie";
import type { Staff } from "@/lib/server/team/types";

// The export route checks the role on the server. The signed-in staff member is
// replaced here; the role rule itself (checkRole) is the real one.
const who = vi.hoisted(() => ({ staff: null as Staff | null }));
vi.mock("@/lib/server/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/auth")>();
  return { ...real, currentStaff: async () => who.staff };
});

const { GET } = await import("@/app/reports/export/route");

const staff = (role: Staff["role"]): Staff => ({
  userId: "00000000-0000-4000-8000-0000000000a1",
  email: "someone@example.com",
  role,
  operatorId: "demo",
  operatorName: "Demo",
  demo: true,
});

describe("GET /reports/export", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    resetIvoraForTests();
    resetDemoLiveForTests();
    resetDemoCheckoutForTests();
    vi.stubGlobal("fetch", () => {
      throw new Error("demo mode must not call fetch");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("refuses without a signed-in staff member", async () => {
    who.staff = null;
    const res = await GET(new Request("http://localhost/reports/export"));
    expect(res.status).toBe(401);
  });

  it("streams the CSV to a viewer, as an attachment that is never cached", async () => {
    who.staff = staff("viewer");
    const res = await GET(
      new Request("http://localhost/reports/export?period=90d"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="sessions-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    expect(text.startsWith("session_ref,session_type,status,")).toBe(true);
    expect(text.split("\r\n").length).toBeGreaterThan(20);
  });

  it("refuses a staff member without a role", async () => {
    who.staff = { ...staff("viewer"), role: "none" as Staff["role"] };
    const res = await GET(new Request("http://localhost/reports/export"));
    expect(res.status).toBe(403);
  });

  it("refuses filters it can't read instead of exporting another period", async () => {
    who.staff = staff("viewer");
    const res = await GET(
      new Request(
        "http://localhost/reports/export?period=custom&from=2026-02-30&to=2026-03-01",
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Enter both dates/);
  });
});
