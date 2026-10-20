/** Runs once when the server starts: start the periodic replan in the Node.js runtime. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReplanTimer } = await import("./lib/timer");
  startReplanTimer();
}
