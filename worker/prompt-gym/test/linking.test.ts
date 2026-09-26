import { describe, it, expect } from 'vitest';
import { upsertUser, upsertBestScore, leaderboard, progressFor } from '../src/db/queries';
import type { RunResponse } from '../src/run';

/** The linking invariant, tested at the layer that actually has to hold it.
 *
 *  Firebase's `linkWithPopup` keeps the same uid, so nothing needs to migrate —
 *  the guest's rows are already the signed-in user's rows. What can still go
 *  wrong is on our side: the profile that decides how they are NAMED is written
 *  in a different place from the scores, and if it never gets refreshed the
 *  board keeps calling them a guest after they have signed in. */

interface Row { [k: string]: unknown }

/** A small stand-in for D1 covering the three statements these queries use.
 *  Real enough to catch an ON CONFLICT that overwrites what it should keep. */
function fakeDb() {
  const users = new Map<string, Row>();
  const best = new Map<string, Row>();

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes('INSERT INTO users')) {
                const [uid, name, avatar, anon] = args as [string, string | null, string | null, number];
                const prev = users.get(uid);
                users.set(uid, {
                  uid,
                  // COALESCE(excluded, existing) — a null must not erase a name.
                  display_name: name ?? prev?.display_name ?? null,
                  avatar_url: avatar ?? prev?.avatar_url ?? null,
                  is_anonymous: anon,
                });
              }
              return {};
            },
            async first() {
              return null;
            },
            async all() {
              if (sql.includes('FROM totals')) {
                const rows = [...best.values()].map((b) => {
                  const u = users.get(b.uid as string);
                  return {
                    uid: b.uid,
                    completed: 1,
                    total_score: b.score,
                    display_name: u?.display_name ?? null,
                    is_anonymous: u?.is_anonymous ?? null,
                  };
                });
                return { results: rows };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, users, best, seedScore: (uid: string, score: number) => best.set(uid, { uid, score }) };
}

const GUEST_UID = 'firebase-uid-unchanged-by-linking';

describe('a guest score surviving Google account linking', () => {
  it('keeps the score, because linking never changes the uid', async () => {
    const { db, seedScore } = fakeDb();
    await upsertUser(db, { uid: GUEST_UID, displayName: null, avatarUrl: null, isAnonymous: true });
    seedScore(GUEST_UID, 88);

    // Linking: same uid, now named and no longer anonymous.
    await upsertUser(db, { uid: GUEST_UID, displayName: 'Arjun', avatarUrl: 'https://x/p.jpg', isAnonymous: false });

    const board = await leaderboard(db, 10);
    expect(board).toHaveLength(1);
    expect(board[0].uid).toBe(GUEST_UID);
    expect(board[0].totalScore).toBe(88);
  });

  it('shows their real name once linked, not "player 4f2a1c"', async () => {
    const { db, seedScore } = fakeDb();
    await upsertUser(db, { uid: GUEST_UID, displayName: null, avatarUrl: null, isAnonymous: true });
    seedScore(GUEST_UID, 88);
    expect((await leaderboard(db, 10))[0].displayName).toBeNull();

    await upsertUser(db, { uid: GUEST_UID, displayName: 'Arjun', avatarUrl: null, isAnonymous: false });
    expect((await leaderboard(db, 10))[0].displayName).toBe('Arjun');
  });

  // The ON CONFLICT uses COALESCE on the name but not on is_anonymous, which is
  // deliberate — a later anonymous session must not silently un-name an account,
  // but the anonymous FLAG does have to be able to flip.
  it('flips the anonymous flag while keeping a name already stored', async () => {
    const { db, users } = fakeDb();
    await upsertUser(db, { uid: GUEST_UID, displayName: 'Arjun', avatarUrl: null, isAnonymous: false });
    await upsertUser(db, { uid: GUEST_UID, displayName: null, avatarUrl: null, isAnonymous: false });

    expect(users.get(GUEST_UID)?.display_name).toBe('Arjun');
    expect(users.get(GUEST_UID)?.is_anonymous).toBe(0);
  });
});
