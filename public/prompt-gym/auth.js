import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signInWithCredential,
  linkWithPopup,
  signOut,
  updateProfile,
  GoogleAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

// Public by design: Firebase web config identifies the project, it does not
// authorise anything. Security comes from the authorised-domains list and from
// the Worker verifying every token's signature and `aud`.
const firebaseConfig = {
  apiKey: 'AIzaSyDnH_WHo0-amyN9evSs39w5DQ0zWQB-G4g',
  authDomain: 'arjunuvacha-3de80.firebaseapp.com',
  projectId: 'arjunuvacha-3de80',
  appId: '1:803439518846:web:d42740ad6e11bbe9db642f',
};

const auth = getAuth(initializeApp(firebaseConfig));
const provider = new GoogleAuthProvider();

let currentUser = null;
const listeners = new Set();

/** Resolves once Firebase has told us who we are — restored session, freshly
 *  minted anonymous account, or nobody. Sign-in must wait for this: clicking
 *  before the anonymous session exists would skip linking and quietly strand the
 *  guest's scores on an account nobody can reach again. */
let markReady;
export const authReady = new Promise((resolve) => {
  markReady = resolve;
});

function notify() {
  for (const listener of listeners) listener(currentUser);
}

/** Linking a guest account to Google does not always copy the Google profile
 *  onto the user itself — `displayName` and `photoURL` can stay null while the
 *  provider entry has both. Read either, so the header shows who signed in. */
function profileField(user, key) {
  if (user[key]) return user[key];
  const fromProvider = (user.providerData ?? []).find((p) => p?.[key]);
  return fromProvider ? fromProvider[key] : null;
}

function setUser(user) {
  currentUser = user
    ? {
        uid: user.uid,
        name: profileField(user, 'displayName'),
        photo: profileField(user, 'photoURL'),
        isAnonymous: user.isAnonymous,
      }
    : null;
  notify();
}

export function onUserChanged(listener) {
  listeners.add(listener);
  listener(currentUser);
}

export function getUser() {
  return currentUser;
}

/** A fresh ID token for the Worker. The SDK refreshes it when it is close to
 *  expiring, which is why this is asked for per request rather than cached.
 *
 *  `force` re-mints it immediately. Needed straight after linking: the cached
 *  token predates the Google credential, so it still says the account is
 *  anonymous and still carries no name — which is why every user row in the
 *  database had a null display_name. */
export async function getIdToken(force = false) {
  if (!auth.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken(force);
  } catch {
    return null;
  }
}

/** Copies the Google name and photo onto the Firebase account itself.
 *
 *  Linking a guest account to Google leaves `displayName` and `photoURL` empty on
 *  the account — the Google provider entry has them, the account does not. The ID
 *  token's `name` and `picture` claims mirror the account, so the Worker never saw
 *  a name, and the leaderboard called every linked player "Anonymous User" while
 *  the header, reading the provider entry, showed their real name. Writing the
 *  profile once and re-minting the token fixes it for good; for accounts already
 *  affected it runs on their next visit. Best-effort: a failure here costs a name
 *  on the board, never the session. */
async function repairProfile(user) {
  if (user.isAnonymous || (user.displayName && user.photoURL)) return;
  const displayName = profileField(user, 'displayName');
  const photoURL = profileField(user, 'photoURL');
  if (!displayName && !photoURL) return;
  if (displayName === user.displayName && photoURL === user.photoURL) return;
  try {
    await updateProfile(user, { displayName, photoURL });
    await user.getIdToken(true);
  } catch (err) {
    console.warn('Could not store the Google profile:', err.code ?? err.message);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Before anyone learns who is signed in, so the first request the page makes
    // already carries the name.
    await repairProfile(user);
    setUser(user);
    markReady();
    return;
  }

  // Mid-sign-in, Firebase can report nobody for a moment while it swaps the guest
  // out. That is a hand-over, not a sign-out: do not start a new guest under it.
  if (signingIn) return;

  setUser(null);

  // Nobody signed in: start an anonymous session so the first challenge can be
  // played in one click, with no sign-up wall in front of it.
  try {
    await signInAnonymously(auth);
    // The listener fires again with the new user, which is what resolves ready.
  } catch (err) {
    // Anonymous auth being unavailable must not break play; it only costs the
    // player their score being recorded. Unblock sign-in either way.
    console.warn('Anonymous sign-in unavailable:', err.code ?? err.message);
    markReady();
  }
});

/**
 * Signs in with Google, *linking* the existing anonymous account rather than
 * replacing it, so everything earned before signing in survives.
 *
 * Linking fails when that Google account already has its own PromptGym identity
 * — the user played anonymously here but has signed in before on another device.
 * There is no merging them, so the established account wins and the throwaway
 * anonymous one is abandoned.
 */
/** True while a Google sign-in is replacing the guest session, so the auth
 *  listener does not mistake the hand-over for "nobody is signed in" and start a
 *  fresh anonymous account underneath it. */
let signingIn = false;

export async function signInWithGoogle() {
  // Never race the anonymous session. Clicking before it exists would skip
  // linking and silently start a second, empty account.
  await authReady;
  const anon = auth.currentUser;
  signingIn = true;

  try {
    if (anon?.isAnonymous) {
      try {
        const credential = await linkWithPopup(anon, provider);
        return { ok: true, linked: true, uid: await finish(credential.user) };
      } catch (err) {
        if (err.code !== 'auth/credential-already-in-use' && err.code !== 'auth/email-already-in-use') {
          return { ok: false, error: err.code ?? err.message };
        }
        // That Google account already has its own PromptGym identity. Firebase
        // hands back the credential the player just chose, so sign in with it —
        // NOT with a second popup. A second popup opened after an await is no
        // longer a direct result of the click: browsers may block it, and at best
        // the player picks their account twice.
        const google = GoogleAuthProvider.credentialFromError(err);
        if (google) {
          const credential = await signInWithCredential(auth, google);
          // `linked: false`: the guest's progress stays with the guest, and the
          // account's own saved progress loads — as Arjun asked for existing users.
          return { ok: true, linked: false, uid: await finish(credential.user) };
        }
      }
    }

    const credential = await signInWithPopup(auth, provider);
    return { ok: true, linked: false, uid: await finish(credential.user) };
  } catch (err) {
    return { ok: false, error: err.code ?? err.message };
  } finally {
    signingIn = false;
  }
}

/** The same ending for every path: the Google profile on the account, a token
 *  that carries it, and only then the page told who is signed in — so the first
 *  request after sign-in already has the name and the right uid. */
async function finish(user) {
  await repairProfile(user);
  await user.getIdToken(true);
  setUser(user);
  return user.uid;
}

export async function signOutUser() {
  await signOut(auth);
}
