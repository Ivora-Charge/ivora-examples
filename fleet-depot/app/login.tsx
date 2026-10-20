"use client";
import { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (r.ok) location.reload();
    else
      setMsg(
        ((await r.json().catch(() => ({}))) as { error?: string }).error ??
          "Sign-in failed",
      );
  }
  return (
    <main>
      <h1>Fleet depot</h1>
      <form onSubmit={submit} className="login">
        <label htmlFor="password">Operator password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit">Sign in</button>
        {msg && (
          <p className="warn" role="alert">
            {msg}
          </p>
        )}
      </form>
    </main>
  );
}
