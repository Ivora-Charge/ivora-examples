import type { Metadata } from "next";
import { ocpiUrls } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { DEMO_DRIVER_REF } from "@/lib/tokens/registry";
import { Head } from "../ui/kit";
import { Gated } from "../ui/parts";
import { TokenAdmin } from "./token-admin";

export const metadata: Metadata = { title: "Drivers and tokens" };

export default function TokensPage() {
  return (
    <>
      <Head
        crumbs={["Drivers"]}
        title="Drivers and tokens"
        lead="Who can charge. Each driver has an app token with a contract ID, and may have RFID cards on the same contract."
      />
      <Gated what="see drivers and tokens">
        <TokenAdmin
          tokensUrl={ocpiUrls().tokens}
          sampleDriver={isDemo() ? DEMO_DRIVER_REF : null}
        />
      </Gated>
    </>
  );
}
