// server.js: the whole app. A team noticeboard: anyone signed in can read
// notes; people with the "editor" role can post them.
//
// APP_NAME is the name the app was put online as: the platform sets VMNODES_APP_NAME.
// ROLE_PREFIX is whatever vmnodes.json uses for role names; it need not match APP_NAME.
const http = require("node:http");
const crypto = require("node:crypto");
// Sign-in checking comes from the platform's own package, @vmnodes/identity.
// Until it is on npm, this starter carries it in vendor/ as a tarball pinned by
// its integrity hash in package-lock.json. It will switch to the npm package.
const { VmnodesIdentity, IdentityError } = require("@vmnodes/identity");
const { createPublisher } = require("./publish");
const { openStore } = require("./store");

// The platform sets VMNODES_APP_NAME to the name you gave the app in the portal.
// Shared records are named "<that name>.note", so it must come from there, not be typed in.
const APP_NAME = process.env.VMNODES_APP_NAME || "starter";
// Must match the role names in vmnodes.json exactly ("starter.editor").
const ROLE_PREFIX = "starter";
const EDITOR_ROLE = `${ROLE_PREFIX}.editor`;
const VERSION = require("./package.json").version;
// Set when the image is built (see Dockerfile). Reported as-is, never guessed.
const BUILD_COMMIT = process.env.BUILD_COMMIT || null;
// The platform does NOT set PORT for you: a portal launch (no manifest.json) sends
// traffic to port 3000, fixed; the Advanced path sends it to runtime.port in
// manifest.json. So 3000 here must match whichever of those applies. (PORT is only
// for local tests.)
const PORT = Number(process.env.PORT || 3000);
// Unset, the app listens on every address, which a container needs. The smoke
// test sets 127.0.0.1 and calls that same address, so no other process on the
// machine can take its connections. Like PORT, it is for local tests.
const LISTEN_ADDRESS = process.env.LISTEN_ADDRESS || undefined;

// Refuses to START if sign-in is not configured: without VMNODES_APP_ID, a token
// made for a DIFFERENT app on the same platform would be accepted here.
let identity;
try {
  // Verifies against VMNODES_ISSUER_URL, falling back to VMNODES_PORTAL_URL if that
  // is unset. Also reads VMNODES_APP_ID.
  identity = new VmnodesIdentity();
} catch (err) {
  console.error(`${err.message}\nThe platform sets these when your app is deployed; locally, \`npm run dev\` sets them for you.`);
  process.exit(1);
}
// Where notes are kept, and so how they are published, is decided in ONE place
// (store.js) from DATABASE_URL: Postgres and "snapshot" when a database is set,
// memory and "upsert" when not. Never set the publish mode here by hand.
const store = openStore();
const publisher = createPublisher({ appName: APP_NAME, mode: store.publishMode });

// Publishes one at a time, each reading the list when its turn comes. Two
// overlapping "snapshot" publishes could otherwise arrive out of order, and the
// older list, missing the newer note, would delete it for everyone else.
let publishing = Promise.resolve();
function publishLatest() {
  publishing = publishing
    .then(async () => publisher.publishAll(await store.list()))
    .catch((e) => console.error("publish failed:", e.message));
  return publishing;
}

const KEPT = {
  postgres: "Notes are kept in this app's database, across restarts and updates.",
  memory: "Notes are kept in memory, so they are cleared when the app restarts or is updated.",
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new IdentityError("body too large", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function page(user, notes) {
  const canPost = user.roles.includes(EDITOR_ROLE);
  const list = notes.length
    ? notes.map((n) => `<li><p>${esc(n.text)}</p><small>${esc(n.authorName)} · ${esc(n.postedAt)}</small></li>`).join("")
    : "<li><p>No notes yet.</p></li>";
  const form = canPost
    ? `<form method="post" action="/notes"><label for="t">New note</label><textarea id="t" name="text" required maxlength="500"></textarea><button type="submit">Post note</button></form>`
    : `<p>You can read notes. Posting needs the <code>${esc(EDITOR_ROLE)}</code> role. Ask whoever runs this app to give it to you.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Noticeboard</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0c10;color:#e8e8ee;max-width:640px;margin:0 auto;padding:16px}ul{list-style:none;padding:0}li{border-bottom:1px solid #2a2c35;padding:8px 0}small{color:#9a9cab}textarea{width:100%;min-height:80px;background:#15161c;color:inherit;border:1px solid #2a2c35;border-radius:6px;padding:8px;box-sizing:border-box}button{margin-top:8px;background:#5b5bd6;color:#fff;border:0;border-radius:6px;padding:10px 16px;font:inherit}code{font-family:ui-monospace,monospace}</style></head>
<body><h1>Noticeboard</h1><p id="who">Signed in as <strong>${esc(user.name || user.email)}</strong> (${esc(user.email)})</p><ul id="notes">${list}</ul>${form}<p id="kept"><small>${esc(KEPT[store.kind])}</small></p></body></html>`;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://app");

  // Health is checked by the platform directly, with no signed-in person, so
  // it must NOT require sign-in. It must also be honest: say what is running.
  if (url.pathname === "/health") {
    return send(res, 200, { status: "ok", app: APP_NAME, version: VERSION, buildCommit: BUILD_COMMIT, publishing: publisher.enabled, storage: store.kind });
  }

  // Everything else: who is this? (Throws 401/503 if we cannot tell.)
  const user = await identity.currentUser(req.headers);

  if (url.pathname === "/" && req.method === "GET") return send(res, 200, page(user, await store.list()), "text/html; charset=utf-8");
  if (url.pathname === "/api/me" && req.method === "GET") return send(res, 200, user);
  if (url.pathname === "/api/notes" && req.method === "GET") return send(res, 200, { items: await store.list() });

  if ((url.pathname === "/api/notes" || url.pathname === "/notes") && req.method === "POST") {
    identity.requireRole(user, EDITOR_ROLE); // checked on the SERVER. Hiding a button is not security.
    const raw = await readBody(req);
    const text = (req.headers["content-type"] || "").includes("application/json")
      ? String(JSON.parse(raw || "{}").text || "")
      : String(new URLSearchParams(raw).get("text") || "");
    if (!text.trim() || text.length > 500) return send(res, 400, { error: "text is required (max 500 characters)" });
    const note = { id: crypto.randomUUID(), text: text.trim(), authorId: user.id, authorName: user.name || user.email, postedAt: new Date().toISOString() };
    await store.add(note);
    publishLatest();
    if (url.pathname === "/notes") { res.writeHead(303, { location: "/" }); return res.end(); }
    return send(res, 201, note);
  }

  return send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof IdentityError ? err.status : err instanceof SyntaxError ? 400 : 500;
    if (status >= 500) console.error(err.cause || err);
    send(res, status, { error: status === 500 ? "something went wrong" : err.message });
  });
});
store.init().then(
  () => server.listen({ port: PORT, host: LISTEN_ADDRESS }, () => console.log(`${APP_NAME} ${VERSION} listening on :${server.address().port} (notes kept in ${store.kind})`)),
  (err) => {
    // No fallback to memory: notes kept there would be lost at the next restart.
    console.error(`${err.message}\nDATABASE_URL is set, so this app will not start without its database.`);
    process.exit(1);
  },
);
