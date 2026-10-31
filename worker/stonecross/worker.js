// stonecross worker — online rooms and results, tied to accounts.
//
//   POST /rooms               (signed in)  -> { code }        create a room
//   GET  /rooms/:code                      -> { exists, full } check a code
//   GET  /rooms/:code/ws                   WebSocket; first message { type: 'auth', idToken }
//   POST /results/system      (signed in)  { id, level, starter, moves } -> { result, stats }
//   GET  /me/stats?game=stonecross (signed in) -> your record
//
// Sign-in works as on PromptGym: the page sends a Firebase ID token (a guest's
// or a Google account's) and this Worker verifies it with the same checks as
// worker/prompt-gym (see verify.js). Results are written by this Worker only:
//   - online games are played on the server, so their results are exact;
//   - games against the system are played in the browser (the search needs more
//     CPU than a Worker gets), so the page sends the move list and this Worker
//     replays it with the same engine. Illegal or unfinished games are refused.
//     It can't prove the system's moves came from the real AI; the level is the
//     player's word.
import { newGame, findMove, play } from '../../static/games/stonecross/engine.js';
import { userFromRequest, verifyIdToken, jwksUrlFrom, TokenError } from './verify.js';

const GAME = 'stonecross';
const ROOM_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const LEVELS = new Set(['beginner', 'intermediate', 'difficult']);
const ALLOWED = [
  'https://arjunuvacha.com',
  'https://www.arjunuvacha.com',
  'https://arjunuvacha-3de80.web.app',
  'https://arjunuvacha-3de80.firebaseapp.com',
  'https://arjunuvacha-test.web.app',
  'https://arjunuvacha-test.firebaseapp.com',
];
const allowedOrigin = (o) =>
  !o || ALLOWED.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin && allowedOrigin(origin) ? origin : ALLOWED[0],
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Vary': 'Origin',
});
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });

// ───────────────────────────── D1

async function upsertPlayer(db, user) {
  await db
    .prepare(
      `INSERT INTO players (uid, display_name, avatar_url, is_anonymous)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, players.display_name),
         avatar_url   = COALESCE(excluded.avatar_url, players.avatar_url),
         is_anonymous = excluded.is_anonymous,
         updated_at   = datetime('now')`,
    )
    .bind(user.uid, user.name ?? null, user.picture ?? null, user.isAnonymous ? 1 : 0)
    .run();
}

const resultFor = (winner, seat) => (winner === 'draw' ? 'draw' : winner === seat ? 'win' : 'loss');

/** One finished game and who played it. Idempotent on the game id. */
async function recordGame(db, g, players) {
  const winner = String(g.winner);
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO games (id, game, mode, level, room_code, starter, winner, reason, plies, moves_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(g.id, GAME, g.mode, g.level ?? null, g.roomCode ?? null, g.starter, winner, g.reason ?? null, g.moves.length, JSON.stringify(g.moves)),
    ...players.map((p) =>
      db.prepare('INSERT OR IGNORE INTO game_players (game_id, uid, seat, result) VALUES (?, ?, ?, ?)')
        .bind(g.id, p.uid, p.seat, resultFor(g.winner, p.seat))),
  ]);
}

async function statsFor(db, uid) {
  const empty = () => ({ win: 0, loss: 0, draw: 0 });
  const out = { system: { beginner: empty(), intermediate: empty(), difficult: empty() }, online: empty(), recent: [] };
  const { results: rows } = await db
    .prepare(
      `SELECT g.mode, g.level, gp.result, COUNT(*) AS n
       FROM game_players gp JOIN games g ON g.id = gp.game_id
       WHERE gp.uid = ? AND g.game = ?
       GROUP BY g.mode, g.level, gp.result`,
    )
    .bind(uid, GAME)
    .all();
  for (const r of rows ?? []) {
    const bucket = r.mode === 'online' ? out.online : out.system[r.level];
    if (bucket && r.result in bucket) bucket[r.result] += r.n;
  }
  const { results: recent } = await db
    .prepare(
      `SELECT g.mode, g.level, gp.result, g.reason, g.plies, g.finished_at,
              (SELECT p.display_name FROM game_players o JOIN players p ON p.uid = o.uid
                WHERE o.game_id = g.id AND o.seat <> gp.seat) AS opponent
       FROM game_players gp JOIN games g ON g.id = gp.game_id
       WHERE gp.uid = ? AND g.game = ?
       ORDER BY g.finished_at DESC LIMIT 8`,
    )
    .bind(uid, GAME)
    .all();
  out.recent = (recent ?? []).map((r) => ({
    mode: r.mode, level: r.level, result: r.result, reason: r.reason, plies: r.plies,
    opponent: r.opponent ?? null, finishedAt: r.finished_at,
  }));
  return out;
}

/** Replays a game against the system. Returns the final state, or an error. */
function replaySystemGame(starter, moves) {
  let s = newGame(starter);
  for (const mv of moves) {
    if (s.winner !== null) return { error: 'moves_after_end' };
    if (!Array.isArray(mv) || mv.length !== 2 || !Number.isInteger(mv[0]) || !Number.isInteger(mv[1])) return { error: 'bad_move' };
    const m = findMove(s, mv[0], mv[1]);
    if (!m) return { error: 'illegal_move' };
    s = play(s, m);
  }
  if (s.winner === null) return { error: 'unfinished' };
  return { state: s };
}

// ───────────────────────────── HTTP

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (!allowedOrigin(origin)) return json({ error: 'origin' }, 403, origin);

    const signedIn = async () => {
      const { user, error } = await userFromRequest(request, env);
      if (user) await upsertPlayer(env.DB, user);
      return { user, error };
    };

    if (url.pathname === '/rooms' && request.method === 'POST') {
      const { user, error } = await signedIn();
      if (!user) return json({ error }, 401, origin);
      for (let i = 0; i < 10; i++) {
        const code = String(100000 + Math.floor(Math.random() * 900000));
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const r = await stub.fetch('https://room/create', {
          method: 'POST',
          body: JSON.stringify({ code, uid: user.uid, name: user.name, photo: user.picture, isAnonymous: user.isAnonymous }),
        });
        if (r.ok) return json({ code }, 200, origin);
      }
      return json({ error: 'busy' }, 503, origin);
    }

    if (url.pathname === '/results/system' && request.method === 'POST') {
      const { user, error } = await signedIn();
      if (!user) return json({ error }, 401, origin);
      const body = await request.json().catch(() => null);
      if (!body || typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.id)) return json({ error: 'bad_id' }, 400, origin);
      if (!LEVELS.has(body.level)) return json({ error: 'bad_level' }, 400, origin);
      if (body.starter !== 0 && body.starter !== 1) return json({ error: 'bad_starter' }, 400, origin);
      if (!Array.isArray(body.moves) || body.moves.length > 200) return json({ error: 'bad_moves' }, 400, origin);
      const { state, error: replayError } = replaySystemGame(body.starter, body.moves);
      if (replayError) return json({ error: replayError }, 422, origin);
      // The player is always Ivory (seat 0) against the system.
      await recordGame(env.DB, {
        id: `sys:${user.uid}:${body.id}`, mode: 'system', level: body.level, starter: body.starter,
        winner: state.winner, reason: state.reason, moves: body.moves,
      }, [{ uid: user.uid, seat: 0 }]);
      return json({ result: resultFor(state.winner, 0), stats: await statsFor(env.DB, user.uid) }, 200, origin);
    }

    if (url.pathname === '/me/stats' && request.method === 'GET') {
      const { user, error } = await signedIn();
      if (!user) return json({ error }, 401, origin);
      return json(await statsFor(env.DB, user.uid), 200, origin);
    }

    const m = url.pathname.match(/^\/rooms\/(\d{6})(\/ws)?$/);
    if (m) {
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
      if (m[2]) {
        if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'upgrade' }, 426, origin);
        return stub.fetch(request);
      }
      const info = await stub.fetch('https://room/info').then((r) => r.json());
      return json(info, 200, origin);
    }

    if (url.pathname === '/') return json({ ok: true, service: 'stonecross' }, 200, origin);
    return json({ error: 'not found' }, 404, origin);
  },
};

// ───────────────────────────── a room

// The name another player sees: Google's name and photo, or nothing for a guest.
const publicProfile = (u) => ({
  name: u.isAnonymous ? null : (u.name || null),
  photo: u.isAnonymous ? null : (u.photo || u.picture || null),
  guest: !!u.isAnonymous,
});

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async load() {
    return (await this.ctx.storage.get('room')) || null;
  }
  async save(room) {
    room.touched = Date.now();
    await this.ctx.storage.put('room', room);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  startGame(room, starter) {
    room.game = newGame(starter);
    room.gameId = crypto.randomUUID();
    room.moves = [];
    room.recorded = false;
    room.rematch = [false, false];
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/create') {
      if (await this.load()) return new Response('taken', { status: 409 });
      const c = await request.json();
      await this.save({
        code: c.code,
        seats: [c.uid, null], // Firebase uids
        names: [publicProfile(c), null],
        game: null, // starts when the second player arrives
        games: 0,
        rematch: [false, false],
      });
      return new Response('ok');
    }

    if (url.pathname === '/info') {
      const room = await this.load();
      return Response.json({ exists: !!room, full: !!(room && room.seats[0] && room.seats[1]) });
    }

    // WebSocket. The socket is accepted first and joins a seat once its first
    // message proves who it is (a browser can't put a token in WebSocket headers,
    // and a URL would end up in logs).
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (!(await this.load())) {
      server.accept();
      server.send(JSON.stringify({ type: 'error', code: 'not_found' }));
      server.close(4000, 'not_found');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat: null, uid: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets(seat, exclude) {
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws === exclude || ws.readyState !== 1) return false;
      const a = ws.deserializeAttachment();
      return a && a.seat === seat;
    });
  }

  stateMsg(room, exclude) {
    return JSON.stringify({
      type: 'state',
      game: room.game,
      seats: room.seats.map((t) => !!t),
      online: [this.sockets(0, exclude).length > 0, this.sockets(1, exclude).length > 0],
      names: room.names || [null, null],
      rematch: room.rematch,
      games: room.games,
    });
  }

  broadcast(room, exclude) {
    const msg = this.stateMsg(room, exclude);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment();
      if (!a || a.seat === null) continue;
      try { ws.send(msg); } catch {}
    }
  }

  async record(room) {
    if (room.recorded || !room.game || room.game.winner === null) return;
    try {
      await recordGame(this.env.DB, {
        id: `room:${room.code}:${room.gameId}`, mode: 'online', roomCode: room.code,
        starter: room.game.starter, winner: room.game.winner, reason: room.game.reason, moves: room.moves,
      }, [{ uid: room.seats[0], seat: 0 }, { uid: room.seats[1], seat: 1 }]);
      room.recorded = true;
    } catch (err) {
      console.error('Could not record game', err);
    }
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const reply = (o) => ws.send(JSON.stringify(o));
    if (msg.type === 'ping') return reply({ type: 'pong' });

    const room = await this.load();
    if (!room) return;
    const att = ws.deserializeAttachment() || { seat: null, uid: null };

    if (msg.type === 'auth') {
      let user;
      try {
        user = await verifyIdToken(msg.idToken, this.env.FIREBASE_PROJECT_ID, jwksUrlFrom(this.env));
      } catch (err) {
        reply({ type: 'error', code: 'auth', detail: err instanceof TokenError ? err.message : 'Invalid token' });
        ws.close(4003, 'auth');
        return;
      }
      // Already seated: a refreshed token for the same account updates the name
      // (a guest who just signed in with Google). A different account keeps the
      // seat with the account that took it, as PromptGym keeps a guest's scores.
      if (att.seat !== null) {
        if (user.uid === att.uid) {
          room.names[att.seat] = publicProfile(user);
          await upsertPlayer(this.env.DB, user).catch(() => {});
          await this.save(room);
          this.broadcast(room);
        } else reply({ type: 'notice', code: 'account_changed' });
        return;
      }

      let seat = room.seats.indexOf(user.uid);
      if (seat === -1) {
        seat = room.seats.indexOf(null);
        if (seat === -1) {
          reply({ type: 'error', code: 'full' });
          ws.close(4000, 'full');
          return;
        }
        room.seats[seat] = user.uid;
      }
      room.names ??= [null, null];
      room.names[seat] = publicProfile(user);
      await upsertPlayer(this.env.DB, user).catch((e) => console.error(e));
      if (!room.game && room.seats[0] && room.seats[1]) {
        this.startGame(room, 0);
        room.games = 1;
      }
      await this.save(room);
      ws.serializeAttachment({ seat, uid: user.uid });
      reply({ type: 'hello', seat, code: room.code });
      this.broadcast(room);
      return;
    }

    if (att.seat === null) return reply({ type: 'error', code: 'not_signed_in' });
    const seat = att.seat;
    const reject = (code) => { reply({ type: 'error', code }); ws.send(this.stateMsg(room)); };

    if (msg.type === 'move') {
      const g = room.game;
      if (!g || g.winner !== null) return reject('no_game');
      if (g.turn !== seat) return reject('not_your_turn');
      const m = findMove(g, msg.from, msg.to);
      if (!m) return reject('illegal');
      room.game = play(g, m);
      room.moves ??= [];
      room.moves.push([m.from, m.to]);
      await this.record(room);
      await this.save(room);
      return this.broadcast(room);
    }

    if (msg.type === 'rematch') {
      if (!room.game || room.game.winner === null) return;
      room.rematch[seat] = true;
      if (room.rematch[0] && room.rematch[1]) {
        // Alternate who moves first.
        this.startGame(room, room.games % 2 === 0 ? 0 : 1);
        room.games++;
      }
      await this.save(room);
      return this.broadcast(room);
    }
  }

  async webSocketClose(ws) {
    const room = await this.load();
    if (room) this.broadcast(room, ws);
  }
  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  async alarm() {
    const room = await this.load();
    if (room && Date.now() - room.touched < ROOM_TTL_MS) {
      await this.ctx.storage.setAlarm(room.touched + ROOM_TTL_MS);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4001, 'expired'); } catch {}
    }
    await this.ctx.storage.deleteAll();
  }
}
