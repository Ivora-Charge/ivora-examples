import type { Metadata } from "next";
import { ocpiUrls } from "@/lib/server/config";
import { forEmailAdmin } from "../ui/for-admin";
import { Head } from "../ui/kit";
import { Gated } from "../ui/parts";
import { TokenAdmin } from "./token-admin";

export const metadata: Metadata = { title: "Tokens" };

export default async function TokensPage() {
  // Our address goes only to an admin signed in by email.
  const tokensUrl = await forEmailAdmin(() => ocpiUrls().tokens);
  return (
    <>
      <Head
        crumbs={["Drivers"]}
        title="Tokens"
        lead="What a CPO checks before a driver charges. Change one token by its UID, or send the pushes a CPO missed."
      />
      <Gated what="see tokens">
        <TokenAdmin tokensUrl={tokensUrl} />
      </Gated>
    </>
  );
}
