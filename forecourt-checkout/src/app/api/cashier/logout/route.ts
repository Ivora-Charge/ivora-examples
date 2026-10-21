import { NextResponse } from "next/server";
import { CASHIER_COOKIE } from "@/lib/server/auth";

export async function POST(request: Request) {
  const response = NextResponse.redirect(
    new URL("/cashier/login", request.url),
    303,
  );
  response.cookies.delete(CASHIER_COOKIE);
  return response;
}
