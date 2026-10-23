"use client";

import { useEffect, useRef, useState } from "react";

/** Reads the token from the fragment once, then hides it from the address bar. */
export function useFragmentToken(): string | null | undefined {
  const read = useRef<string | null | undefined>(undefined);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (read.current === undefined) {
      read.current = window.location.hash.slice(1) || null;
      if (read.current)
        history.replaceState(null, "", window.location.pathname);
    }
    setToken(read.current);
  }, []);
  return token;
}
