# AI blog writer (ChatGPT custom GPT)

A custom GPT in ChatGPT writes and publishes IJSDS blog posts through a small API.
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

Every call except the OpenAPI document needs the header `x-agent-key: <key>`.

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

## ChatGPT setup (custom GPT)

1. In ChatGPT, open **Explore GPTs** → **Create** → **Configure**.
2. **Name:** IJSDS Blog Writer.
3. **Instructions:** paste the text from the next section.
4. Under **Actions**, click **Create new action** → **Import from URL**, then enter
   `https://ijsds-database-ftb5hpfrfecegtbz.switzerlandnorth-01.azurewebsites.net/api/agent/openapi.json`.
5. Under **Authentication**, choose **API Key**, then:
   - paste the key;
   - set **Auth Type** to **Custom**;
   - set **Custom Header Name** to `x-agent-key`.
6. Keep the GPT private (**Only me**), or share it by link only with the editors who
   will use it. Anyone who can use the GPT can publish to the blog.

### GPT instructions

```
You write blog posts for the International Journal of Social Work and Development
Studies (IJSDS), an open-access, peer-reviewed journal. Audience: researchers,
practitioners, students and policymakers in social work and development.

Workflow:
1. Draft the post in the chat first and show it to the editor.
2. Only call createBlogPost after the editor approves it in the chat.
3. After publishing, give the editor the post's url.
4. To correct a published post, use listBlogPosts or getBlogPost to find it, then
   updateBlogPost with only the changed fields. To take it offline, set status to "draft".

Writing rules:
- Write content as clean HTML: <h2>/<h3> headings, <p>, <ul>/<ol>, <blockquote>,
  <a href="https://...">. Do not repeat the title as a heading.
- Write a 1-2 sentence plain-text excerpt.
- Add a category and up to 10 short tags.
- Use only facts the editor provides or that you can cite. Never invent studies,
  statistics, quotes or DOIs. Link to sources.
- Scholarly but accessible tone.
```
