export default async function Sticker({
  params,
}: {
  params: Promise<{ id: string; connector: string }>;
}) {
  const { id, connector } = await params;
  return (
    <main>
      <h1>Charger {id}</h1>
      <p>Connector {connector}</p>
      <p>
        This page is a placeholder on your own domain. Point it at your charging
        app or payment flow (see forecourt-checkout). Printed stickers keep
        working if you change platform.
      </p>
    </main>
  );
}
