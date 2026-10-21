"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { actionError } from "@/lib/server/action-errors";
import { requireRole } from "@/lib/server/auth";
import {
  addCharger,
  checkTest,
  editCharger,
  finishAdding,
  getChargers,
  prepareStickers,
  removeCharger,
  resetPassword,
  startTest,
  stopTest,
  testConnection,
  testEnergyKwh,
  type AddResult,
  type RemoteTest,
} from "@/lib/server/chargers";
import { resetDemoChargers } from "@/lib/server/chargers/demo-cookie";
import { isDemo } from "@/lib/server/env";
import { resetDemoFleet } from "@/lib/server/ivora/demo-cookie";
import { formatKwh } from "@/lib/units";

// Technicians and above add, test, edit and print; managers and owners remove. Every
// action checks the signed-in staff member's role on the server first (requireRole),
// the charger service checks it again, and the database checks it in the same
// statement as the write.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
};

const demoNote = () =>
  isDemo() ? " Demo: simulated, nothing was sent to Ivora or a charger." : "";

function refresh(key?: string) {
  revalidatePath("/chargers");
  if (key) revalidatePath(`/chargers/${key}`);
  revalidatePath("/");
}

function withSecret(r: AddResult, ok: string): ActionState {
  return {
    ok,
    secret:
      r.password && r.connectionUrl
        ? {
            password: r.password,
            connectionUrl: r.connectionUrl,
            username: r.username ?? r.charger.name,
          }
        : undefined,
  };
}

export async function addChargerAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("technician");
    const r = await addCharger(getChargers(), actor, {
      name: str(form, "name"),
      label: str(form, "label"),
      connectors: str(form, "connectors"),
      site: str(form, "site"),
      newSite: {
        name: str(form, "siteName"),
        address: str(form, "siteAddress"),
        city: str(form, "siteCity"),
        postalCode: str(form, "sitePostalCode"),
        country: str(form, "siteCountry") || undefined,
      },
    });
    refresh(r.charger.id);
    return {
      ...withSecret(
        r,
        `${r.charger.label ?? r.charger.name} is registered. Set up the charger with the details below, then open it to run the connection test.${demoNote()}`,
      ),
      path: `/chargers/${r.charger.id}`,
    };
  } catch (e) {
    refresh();
    return actionError(e, "charger add");
  }
}

export async function finishAddingAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  try {
    const actor = await requireRole("technician");
    const r = await finishAdding(getChargers(), actor, key);
    refresh(key);
    return withSecret(r, `Registered in Ivora.${demoNote()}`);
  } catch (e) {
    refresh(key);
    return actionError(e, "charger finish");
  }
}

export async function resetPasswordAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  try {
    const actor = await requireRole("technician");
    if (str(form, "confirm") !== "on")
      return {
        error:
          "Tick the box to confirm: the charger can't connect with its old password after this.",
      };
    const r = await resetPassword(getChargers(), actor, key);
    refresh(key);
    return withSecret(
      r,
      `New password set. Enter it in the charger before it next connects.${demoNote()}`,
    );
  } catch (e) {
    return actionError(e, "charger password");
  }
}

export async function connectionTestAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  try {
    const actor = await requireRole("technician");
    const t = await testConnection(getChargers(), actor, key);
    refresh(key);
    return t.passed
      ? { ok: `Connection test passed.${demoNote()}` }
      : {
          error: `Connection test failed: ${[
            !t.online && "the charger is not connected",
            t.online && !t.booted && "it has not sent a BootNotification",
            t.online &&
              !t.heartbeat &&
              "no recent heartbeat (set HeartbeatInterval to 60 seconds)",
          ]
            .filter(Boolean)
            .join("; ")}.`,
        };
  } catch (e) {
    return actionError(e, "connection test");
  }
}

function describeTest(t: RemoteTest): ActionState {
  const energy = formatKwh(testEnergyKwh(t));
  switch (t.phase) {
    case "passed":
      return {
        ok: `Remote start and stop test passed (${energy} delivered).${demoNote()}`,
      };
    case "failed":
      return { error: `Remote test failed. ${t.error ?? ""}`.trim() };
    case "starting":
      return {
        ok: "Start sent. Waiting for the charger to report the session: check again in a few seconds.",
      };
    case "charging":
      return {
        ok: `Charging (${energy} so far). Stop the test when you are ready.${demoNote()}`,
      };
    case "stopping":
      return {
        ok: "Stop sent. Waiting for the charger to end the session: check again in a few seconds.",
      };
  }
}

export async function startTestAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  try {
    const actor = await requireRole("technician");
    const t = await startTest(getChargers(), actor, key, {
      connector: str(form, "connector"),
      confirmed: str(form, "confirm") === "on",
    });
    refresh(key);
    return describeTest(t);
  } catch (e) {
    return actionError(e, "test start");
  }
}

export async function checkTestAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  try {
    const actor = await requireRole("technician");
    const t = await checkTest(getChargers(), actor, key);
    refresh(key);
    return describeTest(t);
  } catch (e) {
    return actionError(e, "test check");
  }
}

export async function stopTestAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  try {
    const actor = await requireRole("technician");
    const t = await stopTest(getChargers(), actor, key);
    refresh(key);
    return describeTest(t);
  } catch (e) {
    return actionError(e, "test stop");
  }
}

export async function editChargerAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  try {
    const actor = await requireRole("technician");
    await editCharger(getChargers(), actor, key, {
      label: str(form, "label"),
      locationId: str(form, "locationId"),
    });
    refresh(key);
    return { ok: `Charger saved.${demoNote()}` };
  } catch (e) {
    return actionError(e, "charger edit");
  }
}

export async function prepareStickersAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  let recordId: string;
  try {
    const actor = await requireRole("technician");
    recordId = (await prepareStickers(getChargers(), actor, key)).id;
    refresh(key);
  } catch (e) {
    return actionError(e, "sticker codes");
  }
  redirect(`/chargers/${recordId}/stickers`);
}

export async function removeChargerAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = str(form, "key") ?? "";
  let message: string;
  try {
    const actor = await requireRole("technician");
    const r = await removeCharger(
      getChargers(),
      actor,
      key,
      str(form, "confirm") === "on",
    );
    message = r.deletedInIvora ? "deleted" : "hidden";
    refresh(key);
  } catch (e) {
    return actionError(e, "charger remove");
  }
  redirect(`/chargers?removed=${message}`);
}

/** Demo only: back to the sample chargers. */
export async function resetDemoChargersAction(): Promise<void> {
  if (!isDemo()) return;
  await requireRole("technician");
  await resetDemoChargers();
  await resetDemoFleet();
  refresh();
}
