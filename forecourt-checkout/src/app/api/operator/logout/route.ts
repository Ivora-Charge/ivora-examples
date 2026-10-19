import { NextResponse } from "next/server";
import { OPERATOR_COOKIE } from "@/lib/server/auth";

export async function POST(request: Request) {
  const response = NextResponse.redirect(
    new URL("/operator/login", request.url),
    303,
  );
  response.cookies.delete(OPERATOR_COOKIE);
  return response;
}
