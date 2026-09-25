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

function notify() {
  for (const listener of listeners) listener(currentUser);
}

export function onUserChanged(listener) {
  listeners.add(listener);
  listener(currentUser);
}

export function getUser() {
  return currentUser;
}

/** A fresh ID token for the Worker. The SDK refreshes it when it is close to
 *  expiring, which is why this is asked for per request rather than cached. */
export async function getIdToken() {
  if (!auth.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken();
  } catch {
    return null;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = {
      uid: user.uid,
      name: user.displayName,
      photo: user.photoURL,
      isAnonymous: user.isAnonymous,
    };
    notify();
    return;
  }

  currentUser = null;
  notify();

  // Nobody signed in: start an anonymous session so the first challenge can be
  // played in one click, with no sign-up wall in front of it.
  try {
    await signInAnonymously(auth);
  } catch (err) {
    // Anonymous auth being unavailable must not break play; it only costs the
    // player their score being recorded.
    console.warn('Anonymous sign-in unavailable:', err.code ?? err.message);
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
  const anon = auth.currentUser;

  if (anon?.isAnonymous) {
    try {
      const credential = await linkWithPopup(anon, provider);
      return { ok: true, linked: true, uid: credential.user.uid };
    } catch (err) {
      if (err.code !== 'auth/credential-already-in-use' && err.code !== 'auth/email-already-in-use') {
        return { ok: false, error: err.code ?? err.message };
      }
      // Fall through: sign in to the account that already exists.
    }
  }

  try {
    const credential = await signInWithPopup(auth, provider);
    return { ok: true, linked: false, uid: credential.user.uid };
  } catch (err) {
    return { ok: false, error: err.code ?? err.message };
  }
}

export async function signOutUser() {
  await signOut(auth);
}
