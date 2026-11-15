# Read-only author directory for the outreach assistant

Lets an AI assistant (ChatGPT) see who is already an IJSDS author, so outreach skips them.
It is read-only and uses its own key, `AGENT_AUTHORS_KEY`. The blog key cannot open it, and this
key cannot open the blog.

## What it returns

Everyone who submitted a paper, plus the corresponding and co-authors named on submissions.
For each: `email`, `name`, `affiliation`, `roles`, `papers_submitted`, `papers_published`,
`first_submitted_at`, `last_submitted_at`, `email_opt_out`.

It returns nothing else: no manuscript titles, decisions, reviews, payments, reviewers or editors.
`email_opt_out` is true when the person turned off email on their account or unsubscribed from blog
emails. Never contact those people.

## Setup

1. Azure App Service, Configuration, add `AGENT_AUTHORS_KEY` (at least 32 characters). Until it
   is set, every request gets 503.
2. ChatGPT, Settings, Apps, Create (developer mode), Server URL:
   `https://<api-host>/api/agent/authors/mcp/<AGENT_AUTHORS_KEY>`, Authentication: none.
   Treat that URL as a password.

## Endpoints

| | |
|---|---|
| `GET /api/agent/authors?q=&since=&limit=&offset=` | List, newest first (limit up to 500) |
| `POST /api/agent/authors/check` `{"emails": [...]}` | Up to 1000 emails: `is_author`, `email_opt_out` |
| `POST /api/agent/authors/mcp/<key>` | MCP tools `list_ijsds_authors`, `check_ijsds_authors` |

REST calls send the key in the `x-agent-key` header. There are 120 requests per hour per instance.

To rotate the key, change it in Azure, then update the URL in ChatGPT.
