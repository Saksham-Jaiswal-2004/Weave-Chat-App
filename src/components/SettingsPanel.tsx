'use client';

import { signOut } from 'firebase/auth';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Avatar } from '@/components/Avatar';
import { CheckIcon, CloseIcon, LogoutIcon, TrashIcon } from '@/components/Icons';
import { api } from '@/lib/api';
import { firebaseAuth } from '@/lib/firebase';
import { AVATAR_TINTS, cn, tintFor } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import { AVATAR_COLORS, type AvatarColor, type UserProfile } from '@/types';

const NAME_MAX = 40;

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Something went wrong.';

const sectionTitle = 'px-1 pb-2 text-xs font-semibold tracking-wide text-mist-500 uppercase';

const rowButton =
  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors motion-reduce:transition-none hover:bg-ink-800 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

const quietButton =
  'rounded-lg px-2.5 py-1.5 text-xs text-mist-400 transition-colors motion-reduce:transition-none hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Profile and account settings. A sibling of `GroupInfoPanel`: the same slide-over
 * shell anchored to the same edge, so the two read as one surface.
 *
 * Every action carries its own busy flag and its own error line. They really are
 * independent — saving a name must not blank out the warning from a failed delete —
 * and a shared error would let a later success quietly hide an earlier failure.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const uid = user?.uid ?? '';
  // The chosen colour lives on the cached `UserProfile`, not on the slimmer
  // session user, so it is read back out of the chat store.
  const storedColor = useChatStore((state) => state.users[uid]?.avatarColor ?? null);

  // Mounted, then shown, so the panel animates in rather than snapping into place.
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const savedName = user?.displayName ?? '';
  const [nameDraft, setNameDraft] = useState(savedName);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  const [color, setColor] = useState<AvatarColor | null>(storedColor);
  const [colorTouched, setColorTouched] = useState(false);
  const [colorBusy, setColorBusy] = useState(false);
  const [colorError, setColorError] = useState<string | null>(null);

  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeDone, setRevokeDone] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteDraft, setDeleteDraft] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    // The name field is the first thing anyone opens this panel to change.
    nameInputRef.current?.focus();
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Until the swatches are touched, follow the store: the profile may only arrive
  // once the conversation list loads, or change from another tab.
  useEffect(() => {
    if (!colorTouched) setColor(storedColor);
  }, [storedColor, colorTouched]);

  if (!user) return null;

  const trimmedName = nameDraft.trim();
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= NAME_MAX;
  const canSaveName = nameValid && trimmedName !== savedName;
  const deleteArmed = savedName.length > 0 && deleteDraft.trim() === savedName;
  const previewName = trimmedName.length > 0 ? trimmedName : savedName;

  /** One place where a saved profile lands in both stores. */
  function applyProfile(next: UserProfile) {
    useAuthStore.getState().patchUser({
      displayName: next.displayName,
      photoURL: next.photoURL,
      email: next.email,
    });
    useChatStore.getState().cacheUsers([next]);
  }

  async function saveName() {
    if (!canSaveName || nameBusy) return;
    setNameBusy(true);
    setNameError(null);
    setNameSaved(false);
    try {
      const { user: next } = await api.updateProfile({ displayName: trimmedName });
      applyProfile(next);
      setNameDraft(next.displayName);
      setNameSaved(true);
    } catch (cause) {
      setNameError(message(cause));
    } finally {
      setNameBusy(false);
    }
  }

  async function chooseColor(next: AvatarColor | null) {
    if (colorBusy) return;
    const previous = color;

    setColorTouched(true);
    setColor(next);
    setColorBusy(true);
    setColorError(null);
    try {
      const { user: saved } = await api.updateProfile({ avatarColor: next });
      applyProfile(saved);
      setColor(saved.avatarColor);
    } catch (cause) {
      // Put the ring back where it was. Leaving it on a colour the server refused
      // is exactly the kind of quiet lie this app has been bitten by before.
      setColor(previous);
      setColorError(message(cause));
    } finally {
      setColorBusy(false);
    }
  }

  async function revokeSessions() {
    if (revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await api.signOutEverywhere();
      setRevokeConfirm(false);
      setRevokeDone(true);
    } catch (cause) {
      setRevokeError(message(cause));
    } finally {
      setRevokeBusy(false);
    }
  }

  async function deleteAccount() {
    if (!deleteArmed || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteAccount();
      await signOut(firebaseAuth());
      router.replace('/login');
    } catch (cause) {
      // Deliberately not cleared on the way out: if the server half-succeeded the
      // person needs to see why, not a panel that silently closes.
      setDeleteError(message(cause));
      setDeleteBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={cn(
          'flex h-full w-full flex-col border-l border-ink-700 bg-ink-900 shadow-2xl outline-none',
          'transition-transform duration-200 ease-out motion-reduce:transition-none sm:max-w-sm',
          shown ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-lg p-1.5 text-mist-400 transition-colors motion-reduce:transition-none hover:bg-ink-800 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
          >
            <CloseIcon className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="scroll-slim flex-1 overflow-y-auto">
          <section className="flex flex-col items-center gap-3 px-5 py-6 text-center">
            <Avatar
              name={previewName}
              seed={user.uid}
              photoURL={user.photoURL}
              color={color}
              size="lg"
              ringClass="border-ink-900"
            />
            <div className="min-w-0 max-w-full">
              <h3 className="truncate text-lg font-semibold">{previewName}</h3>
              <p className="truncate text-xs text-mist-500">{user.email ?? 'No email on file'}</p>
            </div>
          </section>

          <section className="border-t border-ink-800 px-4 py-4">
            <h4 className={sectionTitle}>Display name</h4>

            <div className="flex items-center gap-2">
              <input
                ref={nameInputRef}
                value={nameDraft}
                maxLength={NAME_MAX}
                aria-label="Display name"
                aria-invalid={nameDraft.length > 0 && !nameValid}
                disabled={nameBusy}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  setNameSaved(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveName();
                  if (event.key === 'Escape' && nameDraft !== savedName) {
                    // Escape belongs to the field while there is an edit to abandon;
                    // otherwise it falls through and closes the panel.
                    event.stopPropagation();
                    setNameDraft(savedName);
                    setNameError(null);
                  }
                }}
                className="min-w-0 flex-1 rounded-xl border border-ink-700 bg-ink-800 px-3.5 py-2 text-sm focus:border-weave-500 focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void saveName()}
                disabled={!canSaveName || nameBusy}
                aria-label="Save display name"
                className="rounded-lg bg-weave-500 p-2 text-white transition-colors motion-reduce:transition-none hover:bg-weave-600 focus-visible:ring-2 focus-visible:ring-weave-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckIcon className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-1.5 px-1 text-xs text-mist-500">
              {trimmedName.length === 0
                ? 'A display name is required.'
                : `${trimmedName.length}/${NAME_MAX}`}
              {nameBusy && ' · Saving…'}
              {!nameBusy && nameSaved && ' · Saved'}
            </p>

            {nameError && (
              <p role="alert" className="mt-1 px-1 text-xs text-red-300">
                {nameError}
              </p>
            )}
          </section>

          <section className="border-t border-ink-800 px-4 py-4">
            <h4 className={sectionTitle}>Avatar colour</h4>

            <div role="group" aria-label="Avatar colour" className="flex flex-wrap gap-2 px-1">
              {AVATAR_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => void chooseColor(swatch)}
                  disabled={colorBusy}
                  aria-pressed={color === swatch}
                  aria-label={swatch}
                  title={swatch}
                  className={cn(
                    'h-8 w-8 rounded-full transition-transform motion-reduce:transition-none',
                    'focus-visible:ring-2 focus-visible:ring-weave-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 focus-visible:outline-none',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    AVATAR_TINTS[swatch],
                    color === swatch
                      ? 'ring-2 ring-mist-50 ring-offset-2 ring-offset-ink-900'
                      : 'hover:scale-105'
                  )}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={() => void chooseColor(null)}
              disabled={colorBusy}
              aria-pressed={color === null}
              className={cn(
                'mt-3 flex items-center gap-2.5 rounded-xl border px-3 py-2 text-sm transition-colors motion-reduce:transition-none',
                'focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
                color === null
                  ? 'border-weave-500 bg-ink-800 text-mist-50 ring-2 ring-weave-500/40'
                  : 'border-ink-700 text-mist-400 hover:bg-ink-800 hover:text-mist-50'
              )}
            >
              <span aria-hidden className={cn('h-5 w-5 rounded-full', tintFor(user.uid, null))} />
              Automatic
            </button>

            <p className="mt-2 px-1 text-xs text-mist-500">
              {user.photoURL
                ? 'Your profile photo is shown instead — the colour applies if that photo ever goes away.'
                : 'Automatic derives a colour from your account, so it never changes on its own.'}
              {colorBusy && ' · Saving…'}
            </p>

            {colorError && (
              <p role="alert" className="mt-1 px-1 text-xs text-red-300">
                {colorError}
              </p>
            )}
          </section>

          <section className="border-t border-ink-800 px-4 py-4">
            <h4 className={sectionTitle}>Email</h4>
            <p className="truncate rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-2 text-sm text-mist-200">
              {user.email ?? 'No email on file'}
            </p>
            <p className="mt-1.5 px-1 text-xs text-mist-500">
              Your email cannot be changed here — it is the identity you sign in with.
            </p>
          </section>

          <section className="border-t border-ink-800 px-2 py-3">
            <h4 className={cn(sectionTitle, 'px-3')}>Sessions</h4>

            {revokeConfirm ? (
              <div className="mx-1 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
                <p className="text-xs text-mist-200">
                  Sign out of every other browser and device?
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRevokeConfirm(false)}
                    disabled={revokeBusy}
                    className={quietButton}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void revokeSessions()}
                    disabled={revokeBusy}
                    className="rounded-lg bg-weave-500 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors motion-reduce:transition-none hover:bg-weave-600 focus-visible:ring-2 focus-visible:ring-weave-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {revokeBusy ? 'Signing out…' : 'Sign out everywhere'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setRevokeDone(false);
                  setRevokeError(null);
                  setRevokeConfirm(true);
                }}
                className={cn(rowButton, 'text-mist-200')}
              >
                <LogoutIcon className="h-[18px] w-[18px] shrink-0 text-mist-400" />
                Sign out everywhere
              </button>
            )}

            {revokeDone && (
              <p className="px-3 pt-2 text-xs text-mist-400">
                Done. Your other devices drop out within the hour — a sign-in they
                already hold keeps working until it expires, including this one.
              </p>
            )}

            {revokeError && (
              <p role="alert" className="px-3 pt-2 text-xs text-red-300">
                {revokeError}
              </p>
            )}
          </section>
        </div>

        <footer className="border-t border-ink-800 px-2 py-2">
          {deleteOpen ? (
            <div className="rounded-xl border border-signal-danger/40 bg-ink-850 px-3 py-2.5">
              <p className="text-xs text-mist-200">
                This deletes your profile and every direct message you are part of,
                history included, for both sides. It cannot be undone.
              </p>

              <label htmlFor="settings-delete-confirm" className="mt-2 block text-xs text-mist-400">
                Type <span className="font-semibold text-mist-200">{savedName}</span> to confirm.
              </label>
              <input
                id="settings-delete-confirm"
                value={deleteDraft}
                disabled={deleteBusy}
                autoComplete="off"
                onChange={(event) => setDeleteDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    // Escape abandons the confirmation, not the whole panel.
                    event.stopPropagation();
                    setDeleteOpen(false);
                    setDeleteDraft('');
                    setDeleteError(null);
                  }
                }}
                className="mt-1.5 w-full rounded-xl border border-ink-700 bg-ink-800 px-3.5 py-2 text-sm focus:border-signal-danger focus:outline-none disabled:opacity-60"
              />

              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeleteDraft('');
                    setDeleteError(null);
                  }}
                  disabled={deleteBusy}
                  className={quietButton}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void deleteAccount()}
                  disabled={!deleteArmed || deleteBusy}
                  className="rounded-lg bg-signal-danger px-2.5 py-1.5 text-xs font-semibold text-white transition-colors motion-reduce:transition-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-signal-danger focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deleteBusy ? 'Deleting…' : 'Delete account'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className={cn(rowButton, 'text-red-300')}
            >
              <TrashIcon className="h-[18px] w-[18px] shrink-0" />
              Delete account
            </button>
          )}

          {deleteError && (
            <p role="alert" className="px-3 pt-2 text-xs text-red-300">
              {deleteError}
            </p>
          )}
        </footer>
      </aside>
    </div>
  );
}
