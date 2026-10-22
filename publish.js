// publish.js: shares a curated copy of your data with the rest of the organisation.
//
// Other apps on the platform cannot read your database, and that is on
// purpose. If you want them to see something, you PUBLISH it: you describe a
// record type once, then send the records. Publish only what others need,
// never whole tables.
//
// On the platform, two settings are provided for you: VMNODES_API_URL and
// VMNODES_PUBLISH_TOKEN. Locally they are not set, so publishing switches
// itself off and says so. It does not pretend to succeed.

// `mode` decides what happens to records you do NOT send this time:
//   "upsert"   adds and updates only. Nothing is ever deleted. The safe default.
//   "snapshot" also deletes every record missing from this batch. Use it ONLY
//              when the list is your complete, durable set, read from a
//              database. With notes kept in memory, a restart empties the
//              list, and the next snapshot would delete everything you shared.
function createPublisher({ appName, mode = "upsert", env = process.env, log = console }) {
  if (mode !== "upsert" && mode !== "snapshot") throw new Error(`publish mode must be "upsert" or "snapshot", got ${JSON.stringify(mode)}`);
  const apiUrl = env.VMNODES_API_URL;
  const token = env.VMNODES_PUBLISH_TOKEN;
  // vmnodes.json declares "note/v1"; the platform puts the app's own name in front.
  const entity = `${appName}.note`;

  if (!apiUrl || !token) {
    log.log("publishing is OFF: VMNODES_API_URL / VMNODES_PUBLISH_TOKEN are not set (normal when running locally)");
    return { enabled: false, entity, publishAll: async () => ({ skipped: true }) };
  }

  async function call(path, body) {
    const res = await fetch(apiUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  let described = false;
  async function publishAll(notes) {
    if (!described) {
      await call("/v1/publish/entities", {
        entity,
        description: "Notes posted on the team noticeboard.",
        classification: "internal",
        queryableFields: [
          { name: "text", type: "string" },
          { name: "author", type: "string" },
          { name: "postedAt", type: "timestamp" },
        ],
      });
      described = true;
    }
    await call("/v1/publish/records", {
      entity,
      mode,
      records: notes.map((n) => ({
        recordKey: n.id,
        payload: { text: n.text, author: n.authorName, postedAt: n.postedAt },
        sourceUpdatedAt: n.postedAt,
      })),
    });
    return { published: notes.length };
  }

  return { enabled: true, entity, publishAll };
}

module.exports = { createPublisher };
