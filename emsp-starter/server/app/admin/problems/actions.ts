"use server";

import { driverAppStore } from "@/lib/driver-app/registry";
import type { ProblemReport } from "@/lib/driver-app/store";
import { locationStore } from "@/lib/locations/registry";
import { parseLocationAppId } from "@/lib/locations/search";
import { peerStore } from "@/lib/ocpi/registry";
import { asAdmin as gate, field } from "@/lib/server/admin-action";

/** A problem report as the admin web shows it. */
export type ProblemRow = {
  id: string;
  createdAt: string;
  status: ProblemReport["status"];
  category: ProblemReport["category"];
  message: string;
  /** The CPO's location: `country_code/party_id/location_id`, and its name. */
  location: string;
  locationName: string | null;
  peerId: string | null;
  evseUid: string | null;
  driverRef: string;
  hasPhoto: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
};

export type ProblemsState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
  reports?: ProblemRow[];
  /** One report, with its photo as a data URL. */
  report?: ProblemRow & { photo: string | null };
};

const LIST_LIMIT = 100;
const UUID = /^[0-9a-f-]{36}$/i;

async function row(r: ProblemReport): Promise<ProblemRow> {
  const key = parseLocationAppId(r.locationId);
  const stored = key ? await locationStore().getLocation(key) : null;
  return {
    id: r.id,
    createdAt: r.createdAt,
    status: r.status,
    category: r.category,
    message: r.message,
    location: key
      ? `${key.countryCode}/${key.partyId}/${key.id}`
      : r.locationId,
    locationName: stored?.location.name ?? null,
    peerId: key?.peerId ?? null,
    evseUid: r.evseUid,
    driverRef: r.driverRef,
    hasPhoto: r.photoType !== null,
    resolvedBy: r.resolvedBy,
    resolvedAt: r.resolvedAt,
  };
}

/** Problems drivers reported from the app, newest first. */
export async function listProblemsAction(
  _prev: ProblemsState,
  form: FormData,
): Promise<ProblemsState> {
  return gate(
    form,
    async (): Promise<ProblemsState> => {
      const status = field(form, "status") || "open";
      if (!["open", "resolved", "all"].includes(status))
        return { ok: false, message: "Unknown status." };
      const reports = await driverAppStore().listReports({
        status: status === "all" ? undefined : (status as "open" | "resolved"),
        limit: LIST_LIMIT,
      });
      return {
        ok: true,
        message: reports.length
          ? `${reports.length} report(s)${reports.length === LIST_LIMIT ? `, the newest ${LIST_LIMIT}` : ""}.`
          : "No reports match.",
        reports: await Promise.all(reports.map(row)),
      };
    },
    {
      shown: () => false,
      fallback: "Could not read the reports. Try again.",
      what: "problem list",
    },
  );
}

/** One report, with its photo. */
export async function showProblemAction(
  _prev: ProblemsState,
  form: FormData,
): Promise<ProblemsState> {
  return gate(
    form,
    async (): Promise<ProblemsState> => {
      const id = field(form, "reportId").trim();
      if (!UUID.test(id))
        return { ok: false, message: "Report ID must be a UUID." };
      const r = await driverAppStore().getReport(id.toLowerCase());
      if (!r) return { ok: false, message: "No such report." };
      return {
        ok: true,
        message: `Report ${r.id}.`,
        report: {
          ...(await row(r)),
          // Checked to be a JPEG or PNG by its bytes when the driver sent it.
          photo:
            r.photoType && r.photoBase64
              ? `data:${r.photoType};base64,${r.photoBase64}`
              : null,
        },
      };
    },
    {
      shown: () => false,
      fallback: "Could not read the report. Try again.",
      what: "problem report",
    },
  );
}

/** Marks a report resolved, with who did it, in the report and the audit log. */
export async function resolveProblemAction(
  _prev: ProblemsState,
  form: FormData,
): Promise<ProblemsState> {
  return gate(
    form,
    async (actor): Promise<ProblemsState> => {
      const id = field(form, "reportId").trim();
      if (!UUID.test(id))
        return { ok: false, message: "Report ID must be a UUID." };
      const done = await driverAppStore().resolveReport(
        id.toLowerCase(),
        actor,
        new Date().toISOString(),
      );
      if (!done) return { ok: false, message: "No open report with this ID." };
      try {
        // The report and its category; never the driver's words or photo.
        await peerStore().audit({
          actor,
          action: "problem.resolved",
          subjectId: done.id,
          details: { category: done.category },
        });
      } catch (e) {
        console.error(
          `Audit of report ${done.id} failed: ${e instanceof Error ? e.name : "unknown error"}`,
        );
      }
      return { ok: true, message: `Report ${done.id} is resolved.` };
    },
    {
      shown: () => false,
      fallback: "Could not change the report. Try again.",
      what: "problem resolve",
    },
  );
}
