import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/server/auth";
import { config } from "@/lib/server/env";
import { getChargers, loadCharger } from "@/lib/server/chargers";
import { qrBase, qrSvg } from "@/lib/server/qr";
import { stickerUrl } from "@/lib/server/qr-base";
import { PrintButton } from "./print-button";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "QR stickers" };

/**
 * One sticker per connector, to print. Each QR code is <your domain>/c/<code>: never an
 * Ivora or hosting-provider address, and refused until that domain is set.
 */
async function Content({ params }: { params: Promise<{ key: string }> }) {
  const me = await requireRole("viewer");
  const { key } = await params;
  const r = await loadCharger(getChargers(), me, key);
  if (!r.ok)
    return (
      <p className="error" role="alert">
        {r.error}
      </p>
    );
  const c = r.charger;
  if (!c) notFound();
  const base = await qrBase();
  const back = (
    <p className="no-print">
      <Link href={`/chargers/${c.key}`}>← {c.label}</Link>
    </p>
  );
  if (!base.ok)
    return (
      <>
        {back}
        <h1>QR stickers</h1>
        <p className="error" role="alert">
          Stickers can&apos;t be printed yet. {base.reason}
        </p>
      </>
    );
  const coded = c.connectors.filter((k) => k.code);
  const stickers = await Promise.all(
    coded.map(async (k) => {
      const url = stickerUrl(base.base, k.code!);
      return { ...k, url, svg: await qrSvg(url) };
    }),
  );
  return (
    <>
      {back}
      <h1 className="no-print">QR stickers: {c.label}</h1>
      {base.demo && (
        <p className="notice no-print" role="note">
          Demo stickers point at this demo&apos;s own address and are marked
          &quot;Demo, not for printing&quot;.
        </p>
      )}
      {stickers.length === 0 ? (
        <p className="muted">
          No sticker codes yet. Create them on the charger&apos;s page.
        </p>
      ) : (
        <>
          <p className="no-print">
            <PrintButton />
          </p>
          <div className="stickers">
            {stickers.map((s) => (
              <article
                key={s.code}
                className="sticker"
                aria-label={`Sticker for connector ${s.number}`}
              >
                <p className="sticker-title">Scan to charge</p>
                {/* Generated on the server from our own URL; contains only SVG shapes. */}
                <div
                  className="sticker-qr"
                  role="img"
                  aria-label={`QR code for ${s.url}`}
                  dangerouslySetInnerHTML={{ __html: s.svg }}
                />
                <p className="sticker-connector">Connector {s.number}</p>
                <p className="sticker-name">
                  {config.operatorName} · {c.label}
                </p>
                <p className="sticker-code">Code {s.code}</p>
                <p className="sticker-url">{s.url}</p>
                {base.demo && (
                  <p className="sticker-demo">Demo, not for printing</p>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** The page behind its loading skeleton. */
export default function Page(props: Parameters<typeof Content>[0]) {
  return (
    <Loading shape="detail">
      <Content {...props} />
    </Loading>
  );
}
