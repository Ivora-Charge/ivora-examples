import { describe, expect, it } from "vitest";
import {
  assignableRoles,
  atLeast,
  canChangeRole,
  canInvite,
  canRemove,
  isRole,
  leavesNoOwner,
  ROLES,
  type Role,
} from "@/lib/roles";

const me = (role: Role) => ({ userId: "me", role });
const them = (role: Role) => ({ userId: "them", role });

describe("role matrix", () => {
  it("ranks owner > manager > technician > viewer", () => {
    // atLeast(role, min) for every pair: row = role, column = min.
    const matrix = ROLES.map((role) =>
      ROLES.map((min) => (atLeast(role, min) ? 1 : 0)),
    );
    expect(matrix).toEqual([
      // owner manager technician viewer
      [1, 1, 1, 1], // owner
      [0, 1, 1, 1], // manager
      [0, 0, 1, 1], // technician
      [0, 0, 0, 1], // viewer
    ]);
  });

  it("lets owners invite anyone and managers only below themselves", () => {
    expect(assignableRoles("owner")).toEqual(ROLES);
    expect(assignableRoles("manager")).toEqual(["technician", "viewer"]);
    expect(assignableRoles("technician")).toEqual([]);
    expect(assignableRoles("viewer")).toEqual([]);
    expect(canInvite("manager", "manager")).toBe(false);
    expect(canInvite("manager", "viewer")).toBe(true);
    expect(canInvite("technician", "viewer")).toBe(false);
  });

  it("checks every role change: actor × target × new role", () => {
    const allowed: string[] = [];
    for (const a of ROLES)
      for (const t of ROLES)
        for (const to of ROLES)
          if (canChangeRole(me(a), them(t), to))
            allowed.push(`${a}:${t}>${to}`);
    expect(allowed).toEqual([
      // Owners change anyone to anything.
      "owner:owner>manager",
      "owner:owner>technician",
      "owner:owner>viewer",
      "owner:manager>owner",
      "owner:manager>technician",
      "owner:manager>viewer",
      "owner:technician>owner",
      "owner:technician>manager",
      "owner:technician>viewer",
      "owner:viewer>owner",
      "owner:viewer>manager",
      "owner:viewer>technician",
      // Managers move technicians and viewers between those two roles only.
      "manager:technician>viewer",
      "manager:viewer>technician",
    ]);
  });

  it("checks every removal: actor × target", () => {
    const allowed: string[] = [];
    for (const a of ROLES)
      for (const t of ROLES)
        if (canRemove(me(a), them(t))) allowed.push(`${a}:${t}`);
    expect(allowed).toEqual([
      "owner:owner",
      "owner:manager",
      "owner:technician",
      "owner:viewer",
      "manager:technician",
      "manager:viewer",
    ]);
  });

  it("never lets anyone remove themselves, and lets an owner step down", () => {
    for (const r of ROLES) expect(canRemove(me(r), me(r))).toBe(false);
    expect(canChangeRole(me("owner"), me("owner"), "manager")).toBe(true);
    expect(canChangeRole(me("manager"), me("manager"), "viewer")).toBe(false);
  });

  it("spots a change that would leave no owner", () => {
    const one = [me("owner"), them("manager")];
    expect(leavesNoOwner(one, "me", "manager")).toBe(true);
    expect(leavesNoOwner(one, "me", null)).toBe(true);
    expect(leavesNoOwner(one, "me", "owner")).toBe(false);
    expect(leavesNoOwner(one, "them", null)).toBe(false);
    const two = [me("owner"), them("owner")];
    expect(leavesNoOwner(two, "me", "viewer")).toBe(false);
    expect(leavesNoOwner(two, "me", null)).toBe(false);
  });

  it("recognises roles", () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
