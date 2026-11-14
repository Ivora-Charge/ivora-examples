"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { SETUP_HIDDEN_COOKIE } from "@/lib/setup-hidden";
import { requireRole } from "@/lib/server/auth";

/** Hides the Overview's setup checklist (a collapsed line at the foot of the page). */
export async function hideSetupAction() {
  await requireRole("manager");
  (await cookies()).set(SETUP_HIDDEN_COOKIE, "1", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    // Only the server reads it.
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  revalidatePath("/");
}

/** Brings the checklist back to the top. */
export async function showSetupAction() {
  await requireRole("manager");
  (await cookies()).delete(SETUP_HIDDEN_COOKIE);
  revalidatePath("/");
}
