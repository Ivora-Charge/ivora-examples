import { NextResponse } from "next/server";
import { IvoraError } from "./ivora";

export function fail(e: unknown) {
  if (e instanceof IvoraError) {
    return NextResponse.json(
      {
        error: e.code,
        message: e.message,
        docs: process.env.IVORA_ERRORS_URL || null,
      },
      { status: e.status },
    );
  }
  return NextResponse.json(
    { error: "bad_request", message: (e as Error).message },
    { status: 400 },
  );
}
