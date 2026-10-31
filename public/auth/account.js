// <au-account>: the sign-in control used across arjunuvacha.com.
//
// The same Google button and user chip as PromptGym's header, as one element any
// page can drop in:
//
//   <script type="module" src="/auth/account.js"></script>
//   <au-account></au-account>                      PromptGym-style header control
//   <au-account variant="compact"></au-account>    avatar only, for tight spaces
//   (variant="sidebar" is a full-width pill, unused for now)
//
// Used on /games/ and the game pages; PromptGym has its own header markup over the
// same /auth/auth.js. It shows the last known profile straight away and loads
// Firebase after that, so a page never waits on sign-in to render.
// A PromptGym guest counts as signed out here; signing in links the guest, so
// their PromptGym scores carry over.

const GOOGLE_G = `<svg class="au-acc-g" viewBox="0 0 18 18" aria-hidden="true">
  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
  <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/>
  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
</svg>`;
const CHEVRON = `<svg class="au-acc-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const CSS = `
au-account { display: inline-flex; align-items: center; position: relative; font-size: 14px; line-height: 1.2; }
au-account[hidden] { display: none; }
.au-acc-btn {
  display: inline-flex; align-items: center; gap: .6em; font: 500 14px/1 inherit; font-family: inherit;
  padding: .6em 1em .6em .8em; background: #fff; color: #1b1d1f;
  border: 1px solid #cfd1cd; border-radius: 999px; cursor: pointer; white-space: nowrap;
  box-shadow: 0 1px 2px rgba(16,24,32,.05), 0 1px 3px rgba(16,24,32,.06); transition: box-shadow .15s, border-color .15s;
}
.au-acc-btn:hover { border-color: #d9480f; box-shadow: 0 2px 8px rgba(16,24,32,.12); }
.au-acc-btn:disabled { opacity: .6; cursor: progress; }
.au-acc-g { width: 18px; height: 18px; flex: none; }
.au-acc-chip {
  display: inline-flex; align-items: center; gap: .55em; padding: .25em .6em .25em .25em; max-width: 100%;
  background: #fff; color: #1b1d1f; border: 1px solid #e3e4e1; border-radius: 999px;
  font: inherit; font-size: 14px; cursor: pointer;
}
.au-acc-chip:hover { border-color: #cfd1cd; }
.au-acc-name { max-width: 12em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.au-acc-chev { width: 12px; height: 12px; color: #747474; flex: none; }
.au-acc-av {
  width: 30px; height: 30px; flex: none; border-radius: 50%; display: inline-grid; place-items: center; overflow: hidden;
  background: #fbe9e1; color: #d9480f; font-weight: 700; font-size: 13px;
}
.au-acc-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.au-acc-menu {
  position: absolute; right: 0; top: calc(100% + 8px); z-index: 1000; min-width: 220px;
  background: #fff; color: #1b1d1f; border: 1px solid #e3e4e1; border-radius: 12px; padding: 6px;
  box-shadow: 0 12px 32px rgba(16,24,32,.16); text-align: left;
}
.au-acc-menu p { margin: 6px 10px 8px; font-size: 13px; color: #747474; overflow-wrap: anywhere; }
.au-acc-menu p strong { color: #1b1d1f; font-weight: 600; }
.au-acc-item {
  display: block; width: 100%; text-align: left; border: 0; background: none; font: inherit; font-size: 14px;
  color: inherit; padding: 9px 10px; border-radius: 8px; cursor: pointer; text-decoration: none;
}
.au-acc-item:hover { background: #f5f5fa; }
.au-acc-sep { height: 1px; background: #e3e4e1; margin: 4px 6px; }
.au-acc-wait { color: #747474; font-size: 13px; }
au-account { gap: .75em; }
.au-acc-guest { font-size: 12.8px; color: #747474; white-space: nowrap; }
@media (max-width: 560px) { .au-acc-guest { display: none; } }
.au-acc-toast {
  position: fixed; left: 50%; top: 76px; transform: translateX(-50%); z-index: 2000;
  background: #1b1d1f; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 14px;
  box-shadow: 0 12px 32px rgba(16,24,32,.2); max-width: calc(100vw - 32px);
}
au-account :focus-visible { outline: 2px solid #d9480f; outline-offset: 2px; }

/* The blog sidebar: a full-width pill that fits the theme's column. */
au-account[variant="sidebar"] { display: flex; width: 100%; }
au-account[variant="sidebar"] .au-acc-btn,
au-account[variant="sidebar"] .au-acc-chip { width: 100%; justify-content: center; }
au-account[variant="sidebar"] .au-acc-chip { justify-content: flex-start; }
au-account[variant="sidebar"] .au-acc-chip .au-acc-name { flex: 1; max-width: none; text-align: left; }
au-account[variant="sidebar"] .au-acc-menu { left: 0; right: auto; width: 100%; }

/* The phone bar: avatar, or a small "Sign in". */
au-account[variant="compact"] .au-acc-name,
au-account[variant="compact"] .au-acc-chev { display: none; }
au-account[variant="compact"] .au-acc-chip { padding: 2px; }
au-account[variant="compact"] .au-acc-btn { padding: .45em .75em .45em .6em; font-size: 13px; }
`;

function injectCss() {
  if (document.getElementById('au-account-css')) return;
  const style = document.createElement('style');
  style.id = 'au-account-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

const initial = (name) => (name?.trim()?.[0] ?? '?').toUpperCase();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function avatar(name, photo) {
  const span = document.createElement('span');
  span.className = 'au-acc-av';
  if (photo) {
    const img = document.createElement('img');
    img.src = photo;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    // A Google avatar URL can 403 from some referrers; fall back to an initial.
    img.addEventListener('error', () => { span.textContent = initial(name); });
    span.appendChild(img);
  } else span.textContent = initial(name);
  return span;
}

let authModule = null;
function loadAuth() {
  authModule ??= import('/auth/auth.js');
  return authModule;
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'au-acc-toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

class AuAccount extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;
    injectCss();
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('au-user')); } catch {}
    // Until Firebase answers: the cached profile, or a quiet "Sign in" button
    // that waits for Firebase when clicked.
    this.render(cached ? { ...cached, isAnonymous: false } : null, !cached);
    loadAuth().then(async (m) => {
      // `onUserChanged` reports null before Firebase has looked; listen once it has,
      // so the cached profile is not wiped and redrawn.
      await m.authReady;
      m.onUserChanged((user) => this.render(user, false));
    }).catch((err) => {
      console.warn('Sign-in unavailable:', err);
      this.hidden = true;
    });
    this._outside = (e) => { if (!this.contains(e.target)) this.closeMenu(); };
    document.addEventListener('click', this._outside);
    this.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeMenu(); });
  }

  disconnectedCallback() {
    document.removeEventListener('click', this._outside);
  }

  closeMenu() {
    const menu = this.querySelector('.au-acc-menu');
    if (!menu) return;
    menu.hidden = true;
    this.querySelector('.au-acc-chip')?.setAttribute('aria-expanded', 'false');
  }

  render(user, pending) {
    const signedIn = user && !user.isAnonymous;
    const guest = !!(user && user.isAnonymous);
    const key = signedIn ? `in|${user.name}|${user.photo}` : `out|${pending}|${guest}`;
    if (key === this._key) return;
    this._key = key;
    this.replaceChildren();

    if (!signedIn) {
      // As in PromptGym's header: a guest can play fully, signing in is what
      // makes their record follow them.
      if (guest && this.getAttribute('variant') !== 'compact') {
        const note = document.createElement('span');
        note.className = 'au-acc-guest';
        note.textContent = 'Playing as a guest';
        this.appendChild(note);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'au-acc-btn';
      btn.innerHTML = `${GOOGLE_G}<span>${this.getAttribute('variant') === 'compact' ? 'Sign in' : 'Sign in with Google'}</span>`;
      btn.addEventListener('click', () => this.signIn(btn));
      this.appendChild(btn);
      return;
    }

    const name = user.name || 'Signed in';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'au-acc-chip';
    chip.setAttribute('aria-haspopup', 'menu');
    chip.setAttribute('aria-expanded', 'false');
    chip.setAttribute('aria-label', `Account: ${name}`);
    chip.appendChild(avatar(name, user.photo));
    chip.insertAdjacentHTML('beforeend', `<span class="au-acc-name">${esc(name)}</span>${CHEVRON}`);

    const menu = document.createElement('div');
    menu.className = 'au-acc-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.innerHTML = `<p>Signed in as <strong>${esc(name)}</strong></p>
      <a class="au-acc-item" role="menuitem" href="/games/">Games</a>
      <a class="au-acc-item" role="menuitem" href="/prompt-gym/">PromptGym</a>
      <div class="au-acc-sep" role="separator"></div>
      <button class="au-acc-item" role="menuitem" type="button" data-signout>Sign out</button>`;
    menu.querySelector('[data-signout]').addEventListener('click', () => this.signOut());

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      chip.setAttribute('aria-expanded', String(!menu.hidden));
    });
    this.append(chip, menu);
  }

  async signIn(btn) {
    btn.disabled = true;
    try {
      const m = await loadAuth();
      await m.authReady;
      const result = await m.signInWithGoogle();
      if (!result.ok) {
        // A closed popup is the user changing their mind, not a failure.
        if (result.error === 'auth/popup-closed-by-user' || result.error === 'auth/cancelled-popup-request') return;
        toast(`Sign-in failed: ${result.error}`);
        return;
      }
      const u = m.getUser();
      // The same two outcomes PromptGym reports: a guest linked to Google keeps
      // everything; a Google account that already existed loads its own record.
      toast(result.linked
        ? 'Signed in. Your games carried over.'
        : `Welcome back${u?.name ? `, ${u.name.split(' ')[0]}` : ''}. Your saved record is loaded.`);
    } catch (err) {
      toast("Sign-in isn't available right now.");
      console.warn(err);
    } finally {
      btn.disabled = false;
    }
  }

  async signOut() {
    this.closeMenu();
    const m = await loadAuth();
    try { localStorage.removeItem('au-user'); } catch {}
    this.render(null, false);
    await m.signOutUser();
  }
}

if (!customElements.get('au-account')) customElements.define('au-account', AuAccount);
