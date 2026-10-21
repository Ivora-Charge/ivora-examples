export default function Loading() {
  return (
    <main id="main" aria-busy="true" aria-label="Loading">
      <div className="skeleton h1" />
      <div className="skeleton card" />
    </main>
  );
}
