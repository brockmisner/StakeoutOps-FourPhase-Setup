"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/config";
import {
  arePublicSignupsAllowed,
  INVITATION_REQUIRED_MESSAGE,
} from "@/lib/auth/signup-policy";
import { createAuthCallbackUrl, safeAuthNext } from "@/lib/auth/redirect";

import styles from "./auth.module.css";

type Mode = "login" | "signup";

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configured = hasSupabaseBrowserConfig();
  const publicSignupsAllowed = arePublicSignupsAllowed();
  const signupBlocked = mode === "signup" && !publicSignupsAllowed;
  const demo =
    process.env.NEXT_PUBLIC_DEMO_MODE === "true" && !configured;
  const next = useMemo(
    () => safeAuthNext(searchParams.get("next")),
    [searchParams],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);

    try {
      if (signupBlocked) throw new Error(INVITATION_REQUIRED_MESSAGE);
      if (!configured) throw new Error("Authentication is not configured.");
      const supabase = createSupabaseBrowserClient();

      if (mode === "login") {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (authError) throw authError;
        router.replace(next);
        router.refresh();
      } else {
        const { data, error: authError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: createAuthCallbackUrl(window.location.origin, next),
          },
        });
        if (authError) throw authError;

        if (data.session) {
          router.replace(next);
          router.refresh();
        } else {
          setMessage(
            "Confirmation requested. Check your inbox and spam, then sign in.",
          );
        }
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Authentication failed.",
      );
    } finally {
      setPending(false);
    }
  }

  async function sendMagicLink() {
    if (!email.trim()) {
      setError("Enter your email first.");
      return;
    }

    setPending(true);
    setError(null);
    setMessage(null);
    try {
      if (signupBlocked) throw new Error(INVITATION_REQUIRED_MESSAGE);
      if (!configured) throw new Error("Authentication is not configured.");
      const supabase = createSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: createAuthCallbackUrl(window.location.origin, next),
          shouldCreateUser: publicSignupsAllowed,
        },
      });
      if (authError) throw authError;
      setMessage("Magic link requested. Check your inbox and spam.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to send link.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className={styles.shell}>
      <section className={styles.card}>
        <p className={styles.eyebrow}>Stakeout Ops</p>
        <h1 className={styles.title}>
          {mode === "login" ? "Welcome back." : "Your own command center."}
        </h1>
        <p className={styles.lede}>
          {mode === "login"
            ? publicSignupsAllowed
              ? "Sign in to schedule and monitor your DuoPlus phone fleet."
              : "Sign in with the email address your administrator invited. New workspaces are not open to public signup."
            : "Create a private workspace, then connect your own DuoPlus account."}
        </p>

        {signupBlocked ? (
          <>
            <p className={styles.message}>{INVITATION_REQUIRED_MESSAGE}</p>
            <Link className={`${styles.button} ${styles.buttonLink}`} href="/login">
              Return to sign in
            </Link>
          </>
        ) : demo ? (
          <>
            <p className={styles.message}>
              Preview mode is active. No account or DuoPlus key is required.
            </p>
            <button className={styles.button} onClick={() => router.replace("/")}>
              Open preview
            </button>
          </>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            <label className={styles.label}>
              Email
              <input
                className={styles.input}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label className={styles.label}>
              Password
              <input
                className={styles.input}
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            {message ? <p className={styles.message}>{message}</p> : null}
            {error ? (
              <p className={`${styles.message} ${styles.error}`}>{error}</p>
            ) : null}

            <button className={styles.button} type="submit" disabled={pending}>
              {pending
                ? "Please wait…"
                : mode === "login"
                  ? "Sign in"
                  : "Create workspace"}
            </button>
            <div className={styles.divider}>or</div>
            <button
              className={styles.secondary}
              type="button"
              onClick={sendMagicLink}
              disabled={pending}
            >
              Email me a magic link
            </button>
          </form>
        )}

        {mode === "login" && !publicSignupsAllowed ? (
          <p className={styles.footer}>
            Need access? Ask your Stakeout Ops administrator for an invitation.
          </p>
        ) : (
          <p className={styles.footer}>
            {mode === "login" ? "New here? " : "Already have an account? "}
            <Link
              className={styles.link}
              href={mode === "login" ? "/signup" : "/login"}
            >
              {mode === "login" ? "Create a workspace" : "Sign in"}
            </Link>
          </p>
        )}
      </section>
    </main>
  );
}
