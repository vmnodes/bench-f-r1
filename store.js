// store.js: where the notes are kept.
//
// ONE decision, made here from DATABASE_URL, sets both where notes live AND how
// they are published, so the two can never disagree:
//
//   DATABASE_URL set   notes are kept in Postgres, across restarts and updates.
//                      The list read back is the complete set, so publishing
//                      uses "snapshot": a note removed here is removed for
//                      everyone else too.
//   not set            notes are kept in memory and cleared on every restart.
//                      The list after a restart is NOT the complete set, so
//                      publishing uses "upsert" and never deletes anything.
//
// On the platform, DATABASE_URL is set for you when vmnodes.json says
// "database": true. Locally it is not set, so `npm run dev` uses memory.
//
// There is no fallback. If DATABASE_URL is set but the database cannot be
// reached, the app refuses to start rather than quietly keeping notes in
// memory, where they would be lost at the next restart.

function storageFor(env) {
  return env.DATABASE_URL
    ? { kind: "postgres", publishMode: "snapshot" }
    : { kind: "memory", publishMode: "upsert" };
}

// The database's shape, as an ordered list. Rules for this list:
//   - Add to the END. Never edit or delete an entry that has shipped.
//   - Every entry must be safe to run again: it runs at EVERY start-up, on a database
//     that may already have it.
//   - Only add things (tables, columns with a default, indexes). Never drop or rename.
const MIGRATIONS = [
  `create table if not exists notes (
     seq bigserial primary key,
     id uuid not null unique,
     text text not null,
     author_id text not null,
     author_name text not null,
     posted_at timestamptz not null
   )`,
  // Version 0.2.0: pinning. Notes that exist already are not pinned.
  `alter table notes add column if not exists pinned boolean not null default false`,
];

// Pinned notes first, then newest first. One function, used by both stores.
function byPinnedThenNewest(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return 0; // equal: keep the incoming (newest first) order; Array.sort is stable
}

function memoryStore() {
  const notes = [];
  return {
    ...storageFor({}),
    async init() {},
    async list() { return notes.map((n) => ({ ...n })).sort(byPinnedThenNewest); },
    async add(note) { notes.unshift({ ...note, pinned: false }); },
    async setPinned(id, pinned) {
      const n = notes.find((x) => x.id === id);
      if (!n) return false;
      n.pinned = pinned;
      return true;
    },
    async close() {},
  };
}

function postgresStore(url, { attempts = 5, delayMs = 1000, log = console } = {}) {
  const postgres = require("postgres");
  const sql = postgres(url, { max: 3, onnotice: () => {} });
  return {
    ...storageFor({ DATABASE_URL: url }),
    async init() {
      // First, wait until the database answers. Only a database that cannot be reached is retried.
      for (let i = 1; ; i++) {
        try {
          await sql`select 1`;
          break;
        } catch (err) {
          if (i >= attempts) throw new Error(`could not reach the database after ${attempts} tries: ${err.message}`);
          log.log(`database not reachable yet (try ${i} of ${attempts}): ${err.message}`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      // Then bring the shape up to date, once, under a lock. Not retried: a failed change stops the app.
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(727001)`;
        for (const statement of MIGRATIONS) await tx.unsafe(statement);
      });
    },
    async list() {
      const rows = await sql`select id, text, author_id, author_name, posted_at, pinned from notes order by pinned desc, seq desc`;
      return rows.map((r) => ({ id: r.id, text: r.text, authorId: r.author_id, authorName: r.author_name, postedAt: r.posted_at.toISOString(), pinned: r.pinned }));
    },
    async add(note) {
      await sql`insert into notes (id, text, author_id, author_name, posted_at)
                values (${note.id}, ${note.text}, ${note.authorId}, ${note.authorName}, ${note.postedAt})`;
    },
    async setPinned(id, pinned) {
      const rows = await sql`update notes set pinned = ${pinned} where id = ${id} returning id`;
      return rows.length > 0;
    },
    async close() { await sql.end({ timeout: 5 }); },
  };
}

function openStore({ env = process.env, log = console } = {}) {
  return env.DATABASE_URL ? postgresStore(env.DATABASE_URL, { log }) : memoryStore();
}

module.exports = { openStore, storageFor };
