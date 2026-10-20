import { describe, expect, it } from "vitest";
import { parseRfidCsv } from "@/lib/rfid";

describe("parseRfidCsv", () => {
  it("parses rows and skips the header", () => {
    const r = parseRfidCsv(
      'idTag,driverName,email\nAB12,Ann Lee,ann@example.com\nCD34,"Doe, Jo"\n',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { idTag: "AB12", driverName: "Ann Lee", email: "ann@example.com" },
      { idTag: "CD34", driverName: "Doe, Jo" },
    ]);
  });
  it("handles BOM, CRLF and semicolons", () => {
    const r = parseRfidCsv("﻿AB12;Ann\r\nCD34;Bob\r\n");
    expect(r.rows.map((x) => x.idTag)).toEqual(["AB12", "CD34"]);
  });
  it("reports bad rows with line numbers", () => {
    const r = parseRfidCsv(
      "AB12,Ann\nTOO LONG TAG WITH SPACES!!,Bob\nEF56,\nAB12,Dup\nGH78,Eve,not-an-email",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
  });
});
