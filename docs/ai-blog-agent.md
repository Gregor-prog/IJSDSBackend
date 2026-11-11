# AI blog writer (ChatGPT plugin)

A ChatGPT plugin writes and publishes IJSDS blog posts through a small API.
Its secret key opens only that API: it can create posts and list, read and edit the
posts it created. It cannot delete posts, touch posts written by people, or reach any
other part of the backend.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/agent/openapi.json` | API description for ChatGPT (public, no secrets) |
| GET | `/api/agent/blog/posts` | List the AI's posts, newest first |
| POST | `/api/agent/blog/posts` | Create a post (live immediately unless `status: "draft"`) |
| GET | `/api/agent/blog/posts/{id}` | Read one of the AI's posts |
| PATCH | `/api/agent/blog/posts/{id}` | Edit, publish or unpublish one of the AI's posts |
| POST | `/api/agent/mcp/<key>` | The same four actions as an MCP server, for the ChatGPT plugin |

The REST calls need the header `x-agent-key: <key>`. ChatGPT plugins can't send custom
headers, so the plugin URL carries the key as its last segment. **Treat the plugin URL
as a password.** The MCP tools are `list_blog_posts`, `get_blog_post`, `create_blog_post`
and `update_blog_post`.

Safeguards:

- **Fails closed:** without a key of 32+ characters set on the server, the API answers 503.
- **HTML is cleaned:** post HTML is reduced to article markup (headings, paragraphs, lists,
  links, https images, tables). Scripts, styles, iframes and event handlers are removed.
- **Rate limits:** 30 writes and 300 reads per hour per server instance.
- **Stable links:** a post's link (slug) never changes after it is created.

## Server setup (Azure)

1. In the Azure portal, open the App Service `ijsds-database` → **Settings** →
   **Environment variables** → **App settings**.
2. Add `AGENT_BLOG_KEY` with the key as its value. It must be at least 32 characters.
   Generate one with `openssl rand -hex 32`.
3. Optional: add `AGENT_BLOG_AUTHOR_ID` with the profile id the posts should be credited
   to. Without it, posts show "Editorial Office" as the author.
4. Click **Apply**. The app restarts and applies the database migration automatically.

To revoke access, change or delete `AGENT_BLOG_KEY`.

## ChatGPT setup (plugin)

ChatGPT has replaced custom GPTs with plugins. Plugins that change things (like
publishing a post) are documented for Business, Enterprise and Edu plans. Plus accounts
had this in developer mode, but OpenAI's current docs are unclear, so check that
**Add custom MCP server** appears for you.

1. Open chatgpt.com/plugins on the web (custom plugins don't work in the mobile app).
2. Click **+**, then **Add custom MCP server**.
3. **Name:** IJSDS Blog. **Description:** Publishes posts to the IJSDS blog.
4. **Server URL:**
   `https://ijsds-database-ftb5hpfrfecegtbz.switzerlandnorth-01.azurewebsites.net/api/agent/mcp/<key>`
   (replace `<key>` with the value of `AGENT_BLOG_KEY`).
5. **Authentication:** No authentication. The key in the URL is the protection.
6. Accept the risk warning, choose **Create as a plugin**, then **Install** it.
7. In a chat, type `@` and pick **IJSDS Blog**, then paste the instructions below as your
   first message (or save them in a ChatGPT Project's instructions).

ChatGPT asks you to confirm before it creates or edits a post. That confirmation is
your review step.

To revoke access, change `AGENT_BLOG_KEY` in Azure; the old plugin URL stops working.

### Instructions for the chat

```
You write blog posts for the International Journal of Social Work and Development
Studies (IJSDS), an open-access, peer-reviewed journal. Audience: researchers,
practitioners, students and policymakers in social work and development.

Workflow:
1. Draft the post in the chat first and show it to me.
2. Only call create_blog_post after I approve the final text.
3. After publishing, give me the post's url.
4. To correct a published post, use list_blog_posts or get_blog_post to find it, then
   update_blog_post with only the changed fields. To take it offline, set status to "draft".

Writing rules:
- Write content as clean HTML: <h2>/<h3> headings, <p>, <ul>/<ol>, <blockquote>,
  <a href="https://...">. Do not repeat the title as a heading.
- Write a 1-2 sentence plain-text excerpt.
- Add a category and up to 10 short tags.
- Use only facts I provide or that you can cite. Never invent studies, statistics,
  quotes or DOIs. Link to sources.
- Scholarly but accessible tone.
```

### Test prompt

Use this once after installing, to check the connection end to end without
publishing anything:

```
@IJSDS Blog Run a connection test:
1. Call list_blog_posts and tell me how many posts you found.
2. Call create_blog_post with status "draft", title "Connection test (delete me)",
   excerpt "Test post.", category "Test", tags ["test"], and content
   "<h2>Test</h2><p>This draft checks the ChatGPT connection.</p>".
3. Call get_blog_post with the new post's id and show me its title, status and url.
4. Call update_blog_post on that id to change the title to "Connection test passed",
   keeping status "draft".
5. Summarise what worked and what failed.
```

The test post stays a draft, so it never appears on the website. An editor can delete
it from Manage Blogs.
