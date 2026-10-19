import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void }) => string;
      reset: (id: string) => void;
    };
  }
}

// Cloudflare's always-pass test site key unless the build sets a real one.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA";

const useTurnstile = () => {
  const ref = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState("");

  useEffect(() => {
    const mount = () => {
      if (!ref.current || !window.turnstile || widget.current) return false;
      widget.current = window.turnstile.render(ref.current, { sitekey: SITE_KEY, callback: setToken });
      return true;
    };
    if (mount()) return;
    const timer = setInterval(() => mount() && clearInterval(timer), 200);
    return () => clearInterval(timer);
  }, []);

  // A token is single use, so every submit needs a fresh challenge.
  const reset = () => {
    setToken("");
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
  };
  return { ref, token, reset };
};

const post = (path: string, body: unknown, captcha?: string) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(captcha && { "x-captcha-response": captcha }) },
    body: JSON.stringify(body),
  });

const App = () => {
  const ts = useTurnstile();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [me, setMe] = useState<string>("signed out");
  const [log, setLog] = useState<string[]>([]);

  const note = (line: string) => setLog((l) => [line, ...l].slice(0, 20));

  const refresh = async () => {
    const res = await fetch("/api/me");
    setMe(res.ok ? `signed in as ${((await res.json()) as { userId: string }).userId}` : "signed out");
  };

  useEffect(() => {
    refresh();
  }, []);

  const auth = async (kind: "sign-up" | "sign-in") => {
    const body = kind === "sign-up" ? { email, password, name: email } : { email, password };
    const res = await post(`/api/auth/${kind}/email`, body, ts.token);
    note(`${kind}: ${res.status}`);
    ts.reset();
    refresh();
  };

  const google = async () => {
    const res = await post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/" });
    const data = (await res.json()) as { url?: string };
    if (data.url) window.location.href = data.url;
    else note(`google: ${res.status}`);
  };

  const signOut = async () => {
    note(`sign-out: ${(await post("/api/auth/sign-out", {})).status}`);
    refresh();
  };

  const upload = async (file: File) => {
    const res = await fetch("/api/avatar", { method: "PUT", body: file });
    note(`avatar: ${res.status}`);
  };

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 520, margin: "40px auto", padding: "0 16px" }}>
      <h1>starter-app</h1>
      <p>{me}</p>
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <div ref={ts.ref} />
      <button disabled={!ts.token} onClick={() => auth("sign-up")}>Sign up</button>
      <button disabled={!ts.token} onClick={() => auth("sign-in")}>Sign in</button>
      <button onClick={google}>Sign in with Google</button>
      <button onClick={signOut}>Sign out</button>
      <p>
        Avatar: <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </p>
      <pre>{log.join("\n")}</pre>
    </main>
  );
};

createRoot(document.getElementById("root")!).render(<App />);
