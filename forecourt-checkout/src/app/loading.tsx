/** Shown while any page loads: the page's shape, so nothing jumps when data arrives. */
export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading">
      <div className="skeleton board-skel" />
      <div className="skeleton card-skel" />
      <div className="skeleton card-skel" />
      <p className="muted center" role="status">
        Loading…
      </p>
    </main>
  );
}
