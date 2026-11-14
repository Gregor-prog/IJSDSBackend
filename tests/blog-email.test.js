import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EMAIL_LINK_SECRET ??= "test-secret-for-signed-links";
const { makeToken, readToken, buildMessages, unsubscribeUrl } = await import("../src/modules/blog/blog.subscriptions.js");

test("signed links round-trip and reject tampering or the wrong purpose", () => {
  const t = makeToken("unsubscribe", "a@b.org");
  assert.equal(readToken("unsubscribe", t), "a@b.org");
  assert.equal(readToken("confirm", t), null);
  const [enc, sig] = t.split(".");
  assert.equal(readToken("unsubscribe", `${Buffer.from("x@y.org").toString("base64url")}.${sig}`), null);
  assert.equal(readToken("unsubscribe", `${enc}.${sig.slice(0, -1)}A`), null);
  assert.equal(readToken("unsubscribe", ""), null);
  assert.equal(readToken("unsubscribe", "garbage"), null);
});

test("announcement emails: escaped content, per-recipient unsubscribe, one-click headers", () => {
  const post = { title: 'Calls & "papers" <now>', excerpt: "<script>x</script>", category: "News", slug: "calls-papers", featured_image_url: "http://insecure/img.png" };
  const msgs = buildMessages(post, [{ email: "a@b.org", kind: "account" }, { email: "c@d.org", kind: "subscriber" }]);
  assert.equal(msgs.length, 2);
  const [a, c] = msgs;
  assert.equal(a.to, "a@b.org");
  assert.equal(a.subject, 'New on the IJSDS Blog: Calls & "papers" <now>'); // subjects are plain text
  assert.match(a.html, /Calls &amp; &quot;papers&quot; &lt;now&gt;/);
  assert.doesNotMatch(a.html, /<script>/);
  assert.doesNotMatch(a.html, /http:\/\/insecure/); // non-https images are dropped
  assert.match(a.html, /https:\/\/www\.ijsds\.org\/blog\/calls-papers/);
  assert.match(a.html, /have an account with IJSDS/);
  assert.match(c.html, /subscribed to the IJSDS Blog/);
  const unsubA = unsubscribeUrl("a@b.org");
  assert.ok(a.html.includes(unsubA.replace(/&/g, "&amp;")));
  assert.ok(!c.html.includes(unsubA));
  assert.equal(a.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(a.headers["List-Unsubscribe"].startsWith(`<${unsubA}>`));
});
