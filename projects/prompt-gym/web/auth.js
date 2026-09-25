import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  linkWithPopup,
  signOut,
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

function setUser(user) {
  currentUser = user
    ? {
        uid: user.uid,
        name: user.displayName,
        photo: user.photoURL,
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

onAuthStateChanged(auth, async (user) => {
  if (user) {
    setUser(user);
    markReady();
    return;
  }

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
export async function signInWithGoogle() {
  // Never race the anonymous session. Clicking before it exists would skip
  // linking and silently start a second, empty account.
  await authReady;
  const anon = auth.currentUser;

  if (anon?.isAnonymous) {
    try {
      const credential = await linkWithPopup(anon, provider);
      // Linking keeps the same uid, so Firebase may emit no auth-state change at
      // all. Without this the header would still read "playing as a guest" after
      // a sign-in that actually worked.
      setUser(credential.user);
      // Re-mint the token so the next run carries the name and the real provider
      // rather than the pre-link claims.
      await credential.user.getIdToken(true);
      return { ok: true, linked: true, uid: credential.user.uid };
    } catch (err) {
      if (err.code !== 'auth/credential-already-in-use' && err.code !== 'auth/email-already-in-use') {
        return { ok: false, error: err.code ?? err.message };
      }
      // Fall through: that Google account already has its own PromptGym identity.
    }
  }

  try {
    const credential = await signInWithPopup(auth, provider);
    setUser(credential.user);
    // `linked: false` means the guest progress did NOT come across — it stayed
    // with the anonymous account, which nothing can reach any more. The caller
    // has to say so rather than let it look like a clean sign-in.
    return { ok: true, linked: false, uid: credential.user.uid };
  } catch (err) {
    return { ok: false, error: err.code ?? err.message };
  }
}

export async function signOutUser() {
  await signOut(auth);
}
