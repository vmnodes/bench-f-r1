// test/smoke.js: `npm test`. Proves the starter does what the platform needs:
// it refuses to run without sign-in configured, it checks every token
// properly, it gates posting by role, and health answers without sign-in.
//
// Every "refused" row below has a matching "accepted" row. A check that only
// ever refuses cannot tell a working lock from a door that never opens.
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { SignJWT, generateKeyPair } = require("jose");
const { startMockPortal } = require("../dev/mock-portal");

const APP_ID = "app_smoke_test";
const SERVER = path.join(__dirname, "..", "server.js");
const children = [];
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (expected ${JSON.stringify(want)}, got ${JSON.stringify(got)})`}`);
}

function startApp(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PORT: "0", LISTEN_ADDRESS: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    const onData = (d) => {
      out += d;
      const m = out.match(/listening on :(\d+)/);
      if (m) resolve({ child, port: Number(m[1]), url: `http://127.0.0.1:${m[1]}`, out: () => out });
    };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("exit", (code) => resolve({ child, exited: code, out: () => out }));
  });
}

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// A port nothing can answer on, HELD while a check relies on it. A port
// that is bound, read and released can be taken by another server before the
// check runs, and then the "unreachable" portal answers. This listener stays
// open and resets every connection, so a request fails the way a refused one
// does. (The platform's own test suite has the same helper; the starter
// ships on its own, so it keeps its own copy.)
async function holdDeadPort() {
  const s = net.createServer((sock) => sock.resetAndDestroy());
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { port: s.address().port, release: () => new Promise((r) => s.close(r)) };
}

// "bound" or the error code: can another listener take 127.0.0.1:port?
function tryBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(e.code || "error"));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve("bound")));
  });
}

(async () => {
  // --- 1. It refuses to start without sign-in configured -------------------
  const noAppId = await startApp({ VMNODES_PORTAL_URL: "http://127.0.0.1:1" });
  check("refuses to START without VMNODES_APP_ID", noAppId.exited !== undefined && noAppId.exited !== 0, true);
  check("...and the message names the missing setting", /VMNODES_APP_ID is required/.test(noAppId.out()), true);
  const noPortal = await startApp({ VMNODES_APP_ID: APP_ID });
  check("refuses to START without VMNODES_PORTAL_URL", noPortal.exited !== undefined && noPortal.exited !== 0, true);

  // --- the real run: pretend portal + app ----------------------------------
  const portal = await startMockPortal({ port: 0, appId: APP_ID });
  const app = await startApp({ VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID });
  check("CONTROL: starts when both settings are present", typeof app.url, "string");
  if (!app.url) { console.log(app.out()); process.exit(1); }
  portal.setTarget(app.url);
  // The app is bound to the address this test calls, so no other server
  // on the machine can take its connections. Listening on every address instead
  // lets another server bound to 127.0.0.1 on the same port win them (seen on
  // macOS; Linux refuses that second bind either way).
  check("the app holds 127.0.0.1 on its port itself", await tryBind(app.port), "EADDRINUSE");
  check("CONTROL: the bind check can succeed, so the row above can fail", await tryBind(0), "bound");

  const mint = (claims, { key = portal.privateKey, iss = portal.issuer, aud = APP_ID, exp = "5m", kid = "local-dev" } = {}) =>
    new SignJWT({ email: "e@example.test", name: "Eden Editor", kind: "employee", groups: [], roles: [], ...claims })
      .setProtectedHeader({ alg: "RS256", kid }).setSubject("usr_1").setIssuer(iss).setAudience(aud)
      .setIssuedAt().setExpirationTime(exp).sign(key);
  const as = async (claims, opts) => ({ "x-vmnodes-identity": await mint(claims, opts) });
  const editor = () => as({ roles: ["starter.editor"] });
  const reader = () => as({ name: "Riley Reader", roles: [] });

  // --- 2. Health ------------------------------------------------------------
  const h = await request(`${app.url}/health`);
  check("health answers 200 WITHOUT sign-in", h.status, 200);
  check("health reports the version", h.json().version, require("../package.json").version);
  check("health reports buildCommit as null when not built by the Dockerfile (never a guess)", h.json().buildCommit, null);
  check("health says publishing is off locally", h.json().publishing, false);
  check("health says notes are kept in memory when DATABASE_URL is not set", h.json().storage, "memory");

  // --- 3. Sign-in: one accepted row, then every way a token can be wrong ---
  const me = await request(`${app.url}/api/me`, { headers: await editor() });
  check("CONTROL: a valid token is accepted", me.status, 200);
  check("...and the app knows who it is", me.json().name, "Eden Editor");
  check("no identity header -> 401", (await request(`${app.url}/api/me`)).status, 401);
  check("token meant for ANOTHER app -> 401", (await request(`${app.url}/api/me`, { headers: await as({}, { aud: "app_someone_else" }) })).status, 401);
  check("token from ANOTHER portal -> 401", (await request(`${app.url}/api/me`, { headers: await as({}, { iss: "http://evil.example" }) })).status, 401);
  check("expired token -> 401", (await request(`${app.url}/api/me`, { headers: await as({}, { exp: Math.floor(Date.now() / 1000) - 60 }) })).status, 401);
  const { privateKey: forgedKey } = await generateKeyPair("RS256");
  check("token signed with a FORGED key -> 401", (await request(`${app.url}/api/me`, { headers: await as({}, { key: forgedKey }) })).status, 401);
  const [hd, pl] = (await mint({ roles: ["starter.editor"] })).split(".");
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${pl}.`;
  check("unsigned token (someone just typed the header) -> 401", (await request(`${app.url}/api/me`, { headers: { "x-vmnodes-identity": unsigned } })).status, 401);
  void hd;
  const hs = `${Buffer.from(JSON.stringify({ alg: "HS256", kid: "local-dev" })).toString("base64url")}.${pl}.c2ln`;
  check("token claiming a shared-secret algorithm -> 401", (await request(`${app.url}/api/me`, { headers: { "x-vmnodes-identity": hs } })).status, 401);

  // --- 4. Roles: the server decides, not the button -------------------------
  const post = (headers, text) => request(`${app.url}/api/notes`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text }) });
  check("a reader cannot post -> 403", (await post(await reader(), "hello")).status, 403);
  const made = await post(await editor(), "Fire drill at 3pm <script>alert(1)</script>");
  check("CONTROL: an editor can post -> 201", made.status, 201);
  const list = await request(`${app.url}/api/notes`, { headers: await reader() });
  check("a reader sees the posted note", list.json().items.length, 1);

  // --- 5. Through the pretend portal, as a browser would --------------------
  portal.setUser("editor");
  const pageRes = await request(`${portal.issuer}/`);
  check("via the dev portal the page loads signed in", /Signed in as <strong>Eden Editor<\/strong>/.test(pageRes.body), true);
  check("posted text is escaped, not run as code", pageRes.body.includes("&lt;script&gt;") && !pageRes.body.includes("<script>alert"), true);
  portal.setUser("reader");
  const readerPage = await request(`${portal.issuer}/`);
  check("a reader's page has no post form", !/<form/.test(readerPage.body), true);

  // --- 6. Portal unreachable -> 503, not 401 (it is not the user's fault) -----
  const dead = await holdDeadPort();
  check("the dead portal's port is held: no other server can answer in its place", await tryBind(dead.port), "EADDRINUSE");
  const orphan = await startApp({ VMNODES_PORTAL_URL: `http://127.0.0.1:${dead.port}`, VMNODES_APP_ID: APP_ID });
  const down = await request(`${orphan.url}/api/me`, { headers: await as({}, { iss: `http://127.0.0.1:${dead.port}` }) });
  check("portal unreachable -> 503 (not 'sign in again')", down.status, 503);
  await dead.release();

  // --- 7. What you shared survives a restart --------------------------------
  // A pretend publish API with the platform's real rule: "snapshot" deletes
  // every record the batch does not name, "upsert" only adds and updates.
  // Notes live in memory, so a restart empties the list; the next post must
  // not delete what was shared before it.
  const shared = new Map(); const modes = []; const entities = [];
  const flight = { now: 0, max: 0, delayMs: 0 };
  const api = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", async () => {
      if (req.url === "/v1/publish/records") {
        flight.now++; flight.max = Math.max(flight.max, flight.now);
        if (flight.delayMs) await new Promise((r) => setTimeout(r, flight.delayMs));
        const body = JSON.parse(b); modes.push(body.mode); entities.push(body.entity);
        if (body.mode === "snapshot") {
          const sent = new Set(body.records.map((r) => r.recordKey));
          for (const k of [...shared.keys()]) if (!sent.has(k)) shared.delete(k);
        }
        for (const r of body.records) shared.set(r.recordKey, r.payload);
        flight.now--;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  const pubEnv = { VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID, VMNODES_API_URL: apiUrl, VMNODES_PUBLISH_TOKEN: "smoke-test-publish" };
  const postTo = async (url, text) => request(`${url}/api/notes`, { method: "POST", headers: { ...(await editor()), "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const publishes = async (n) => { for (let i = 0; i < 100 && modes.length < n; i++) await new Promise((r) => setTimeout(r, 20)); return modes.length; };

  const before = await startApp(pubEnv);
  await postTo(before.url, "Posted before the restart");
  check("CONTROL: the first note reaches the platform", [await publishes(1), shared.size], [1, 1]);
  before.child.kill(); await new Promise((r) => (before.child.exitCode !== null ? r() : before.child.once("exit", r)));
  const after = await startApp(pubEnv);
  check("CONTROL: in memory, a restart really clears the notes, so the database check below can fail", (await request(`${after.url}/api/notes`, { headers: await reader() })).json().items.length, 0);
  await postTo(after.url, "Posted after the restart");
  await publishes(2);
  check("after a restart and one more post, the earlier note is STILL shared", shared.size, 2);
  check("the in-memory starter publishes with upsert, never snapshot", modes, ["upsert", "upsert"]);
  await request(`${apiUrl}/v1/publish/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "snapshot", records: [] }) });
  check("CONTROL: the pretend API really deletes on snapshot, so the check above can fail", shared.size, 0);

  // The platform names the app (VMNODES_APP_NAME) and only accepts records under
  // that name, so an app launched as "noticeboard" must share "noticeboard.note".
  const named = await startApp({ ...pubEnv, VMNODES_APP_NAME: "noticeboard" });
  check("/health reports the name the platform gave the app", (await request(`${named.url}/health`)).json().app, "noticeboard");
  entities.length = 0; const modesBefore = modes.length;
  await postTo(named.url, "Posted under a platform name");
  await publishes(modesBefore + 1);
  check("records are shared under the platform's name for the app", entities, ["noticeboard.note"]);
  named.child.kill(); await new Promise((r) => (named.child.exitCode !== null ? r() : named.child.once("exit", r)));

  // --- 8. Publishes go one at a time ------------------------------------------
  // Two overlapping snapshot publishes can arrive out of order, and the older
  // list would delete the newer note. So the app waits for each to finish.
  modes.length = 0; flight.max = 0; flight.delayMs = 150;
  await Promise.all([postTo(after.url, "one"), postTo(after.url, "two"), postTo(after.url, "three")]);
  await publishes(3);
  check("three quick posts make three publishes", modes.length, 3);
  check("...and never two at once", flight.max, 1);
  flight.delayMs = 0;

  // --- 9. A database that cannot be reached stops the app; it never falls back --
  const noDbPort = await holdDeadPort();
  const noDb = await startApp({ VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID, DATABASE_URL: `postgres://starter@127.0.0.1:${noDbPort.port}/starter` });
  check("with DATABASE_URL set and no database, the app refuses to START", noDb.exited !== undefined && noDb.exited !== 0, true);
  check("...and says it will not start without its database", /will not start without its database/.test(noDb.out()), true);
  await noDbPort.release();

  // --- 10. Kept in Postgres: survives a restart, and publishes the full set ---
  // Runs only with TEST_DATABASE_URL, an EMPTY scratch database (the platform's
  // own suite gives it one). It refuses to run on a database that already has a
  // notes table, and drops only the table it made.
  let postgresRan = false;
  const testDb = process.env.TEST_DATABASE_URL;
  if (!testDb) {
    console.log("SKIP postgres section: set TEST_DATABASE_URL to an empty scratch database to run it");
  } else {
    const postgres = require("postgres");
    const sql = postgres(testDb, { max: 1, onnotice: () => {} });
    const [{ exists }] = await sql`select to_regclass('public.notes') is not null as exists`;
    if (exists) { console.log("FAIL TEST_DATABASE_URL already has a notes table; use an empty scratch database"); fail++; }
    else {
      shared.clear(); modes.length = 0;
      const dbEnv = { ...pubEnv, DATABASE_URL: testDb };
      const first = await startApp(dbEnv);
      check("CONTROL: starts with its database", typeof first.url, "string");
      check("health says notes are kept in postgres", (await request(`${first.url}/health`)).json().storage, "postgres");
      await postTo(first.url, "Kept in the database");
      await publishes(1);
      check("with a database, the starter publishes with snapshot", modes, ["snapshot"]);
      first.child.kill(); await new Promise((r) => (first.child.exitCode !== null ? r() : first.child.once("exit", r)));
      const second = await startApp(dbEnv);
      const kept = (await request(`${second.url}/api/notes`, { headers: await reader() })).json().items;
      check("after a restart, the note is still there", kept.map((n) => n.text), ["Kept in the database"]);
      const page = await request(`${second.url}/`, { headers: await reader() });
      check("the page says notes are kept in the database", /kept in this app&#39;s database/.test(page.body), true);
      await postTo(second.url, "Posted after the restart");
      await publishes(2);
      check("the snapshot after a restart carries BOTH notes, so nothing shared is deleted", shared.size, 2);
      check("...and every publish was a snapshot", modes, ["snapshot", "snapshot"]);
      second.child.kill(); await new Promise((r) => (second.child.exitCode !== null ? r() : second.child.once("exit", r)));
      await sql`drop table if exists notes`;
      postgresRan = true;
    }
    await sql.end({ timeout: 5 });
  }
  const memPage = await request(`${after.url}/`, { headers: await reader() });
  check("in memory, the page says notes are cleared on restart", /cleared when the app restarts/.test(memPage.body), true);
  api.close();

  // --- 11. The count itself: zero checks run must never read as a pass ---------
  console.log(`postgres=${postgresRan ? "ran" : "skipped"}`);
  const FLOOR = 40;
  if (pass + fail < FLOOR) { console.log(`FAIL only ${pass + fail} checks ran, expected at least ${FLOOR}`); fail++; }
  console.log(`\npassed=${pass} failed=${fail}`);
  finish(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("smoke test crashed:", e); finish(1); });

function finish(code) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
