'use client';

import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { WeaveMark } from '@/components/Icons';
import { authErrorMessage, firebaseAuth, firebaseConfigured } from '@/lib/firebase';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';

/** The dark theme swallows the UA focus outline, so every control opts into a ring. */
const focusRing = 'focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none';

type Mode = 'signin' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);

  const [mode, setMode] = useState<Mode>('signin');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/chat');
  }, [status, router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const auth = firebaseAuth();
      if (mode === 'signup') {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        const name = displayName.trim();
        if (name) await updateProfile(credential.user, { displayName: name });
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
      router.replace('/chat');
    } catch (cause) {
      setError(authErrorMessage(cause));
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setBusy(true);
    try {
      await signInWithPopup(firebaseAuth(), new GoogleAuthProvider());
      router.replace('/chat');
    } catch (cause) {
      setError(authErrorMessage(cause));
      setBusy(false);
    }
  }

  if (!firebaseConfigured) return <SetupNotice />;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-950 px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span
            aria-hidden
            className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-weave-500 text-white"
          >
            <WeaveMark className="h-7 w-7" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Weave</h1>
          <p className="mt-1.5 text-sm text-mist-400">
            {mode === 'signin' ? 'Sign in to pick up where you left off.' : 'Create an account to start chatting.'}
          </p>
        </div>

        <div className="rounded-2xl border border-ink-700/70 bg-ink-900 p-5 shadow-2xl shadow-black/40 sm:p-6">
          <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-ink-800 p-1">
            {(['signin', 'signup'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setError(null);
                }}
                aria-pressed={mode === value}
                className={cn(
                  'min-h-11 rounded-lg px-3 text-sm font-medium transition-colors',
                  mode === value ? 'bg-ink-700 text-mist-50' : 'text-mist-400 hover:text-mist-200',
                  focusRing
                )}
              >
                {value === 'signin' ? 'Sign in' : 'Sign up'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <Field
                label="Display name"
                value={displayName}
                onChange={setDisplayName}
                placeholder="Ada Lovelace"
                autoComplete="name"
                maxLength={40}
              />
            )}

            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />

            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder={mode === 'signup' ? 'At least 6 characters' : ''}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={6}
              required
            />

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-signal-danger/30 bg-signal-danger/10 px-3 py-2 text-sm text-red-200"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className={cn(
                'min-h-11 w-full rounded-xl bg-weave-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-weave-600 disabled:cursor-not-allowed disabled:opacity-60',
                focusRing
              )}
            >
              {busy ? 'Just a moment…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <div className="my-5 flex items-center gap-3 text-xs text-mist-500">
            <span className="h-px flex-1 bg-ink-700" />
            or
            <span className="h-px flex-1 bg-ink-700" />
          </div>

          <button
            type="button"
            onClick={handleGoogle}
            disabled={busy}
            className={cn(
              'flex min-h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-ink-700 bg-ink-800 px-4 text-sm font-medium text-mist-200 transition-colors hover:bg-ink-750 disabled:cursor-not-allowed disabled:opacity-60',
              focusRing
            )}
          >
            <GoogleGlyph />
            Continue with Google
          </button>
        </div>

        <p className="mt-6 text-center text-xs text-mist-500">
          Messages are text only — no media sharing in this release.
        </p>
      </div>
    </main>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

function Field({ label, value, onChange, ...rest }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-mist-400 uppercase">
        {label}
      </span>
      <input
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'min-h-11 w-full rounded-xl border border-ink-700 bg-ink-800 px-3.5 py-2.5 text-sm text-mist-50 placeholder:text-mist-500 focus-visible:border-weave-500',
          focusRing
        )}
      />
    </label>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.44a5.5 5.5 0 0 1-2.39 3.6v3h3.86c2.26-2.08 3.59-5.15 3.59-8.79Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.86-3c-1.08.72-2.45 1.15-4.08 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.29a12 12 0 0 0 0 10.74l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.63l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}

function SetupNotice() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-950 px-4 py-8">
      <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-900 p-5 sm:p-7">
        <h1 className="text-lg font-semibold">Finish setting up Weave</h1>
        <p className="mt-2 text-sm text-mist-400">
          Firebase credentials are missing. Copy <code className="text-mist-200">.env.example</code>{' '}
          to <code className="text-mist-200">.env.local</code>, fill in your Firebase web-app config
          and service-account keys, then restart the dev server.
        </p>
        <p className="mt-4 text-sm text-mist-500">
          The README walks through creating the project, enabling Email/Password auth and Firestore.
        </p>
      </div>
    </main>
  );
}
