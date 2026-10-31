// PromptGym's sign-in is now the site-wide one, so a player signed in here is
// signed in on the blog and the games too (and the other way round).
// See /auth/auth.js. The one thing PromptGym adds: guest accounts, so a first
// challenge can be played in one click and its score kept until sign-in.
export * from '/auth/auth.js';
import { enableGuests } from '/auth/auth.js';

enableGuests();
