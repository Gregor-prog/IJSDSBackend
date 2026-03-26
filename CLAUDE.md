I am migrating my backend from supabase to this node + express setup

you can access this file url C:\Users\HP\ijsds-scholarly-forge to check how supabase is being integrated into the frontend

Implementation Plan — IJSDS Backend Migration (Supabase → Node/Express + Prisma)
Architecture Overview
The frontend currently calls Supabase directly for everything. The goal is for the frontend to call this Express backend instead, which talks to PostgreSQL via Prisma. Supabase Auth will be replaced with JWT-based auth in Express.

Frontend → Express API → Prisma → PostgreSQL
→ Resend (email)
→ Paystack (payments)
→ Zenodo (DOI)
→ DOAJ (journal indexing)
Phase 1 — Foundation
Tasks:

Set up global error handling middleware (src/middleware/errorHandler.js)
Set up auth middleware — verify JWT on protected routes (src/middleware/auth.js)
Configure Prisma client with connection to the actual PostgreSQL DB (src/config/prisma.js) and run prisma generate
Add DATABASE_URL to .env pointing at the PostgreSQL instance
Phase 2 — Authentication Module
Replaces: supabase.auth.signUp, signInWithPassword, signOut, getUser, onAuthStateChange, resetPasswordForEmail

Tasks: 5. POST /auth/register — create user + profile, hash password, return JWT 6. POST /auth/login — verify credentials, return JWT + user profile 7. POST /auth/logout — token invalidation (blocklist or short-lived tokens) 8. GET /auth/me — return current user from JWT 9. POST /auth/reset-password — send reset email via Resend 10. ORCID OAuth is already implemented — wire it to issue a JWT instead of a Supabase magic link

Phase 3 — Core Data Modules
Replaces: all supabase.from(table).select/insert/update calls on the core tables

Tasks: 11. Submissions module — GET /api/submissions, POST, PATCH /api/submissions/:id + status transitions 12. Articles module — GET /api/articles, GET /api/articles/:id, PATCH /api/articles/:id 13. Profiles module — GET /api/profiles/:id, PATCH /api/profiles/:id (settings, ORCID update) 14. Reviews module — GET /api/reviews, POST /api/reviews, PATCH /api/reviews/:id (accept/decline invitation, submit review) 15. Editorial decisions module — POST /api/editorial-decisions, GET /api/editorial-decisions/:submissionId 16. Revision requests module — POST /api/revision-requests, GET /api/revision-requests/:submissionId 17. Rejection messages module — POST /api/rejection-messages

Phase 4 — Communication Module
Replaces: discussion_threads, discussion_messages, messages, notifications direct Supabase calls + realtime subscriptions

Tasks: 18. Discussion threads — GET /api/discussions/:submissionId, POST /api/discussions 19. Discussion messages — GET /api/discussions/:threadId/messages, POST 20. In-app notifications — GET /api/notifications, PATCH /api/notifications/:id/read 21. Realtime — implement Server-Sent Events (SSE) at GET /api/notifications/stream to replace Supabase realtime subscriptions

Phase 5 — Content Module
Replaces: blog_posts and partners table calls

Tasks: 22. Blog module — GET /api/blog, GET /api/blog/:slug, POST /api/blog, PATCH /api/blog/:id (admin) 23. Partners module — GET /api/partners, POST /api/partners, PATCH /api/partners/:id (admin)

Phase 6 — File & Storage Module
Replaces: Supabase Storage uploads + file_versions table

Tasks: 24. Set up multer for multipart file uploads 25. POST /api/files/upload — accept .pdf/.doc/.docx, store to disk/S3/object storage, save record to file_versions via Prisma 26. GET /api/files/:articleId — list file versions for an article 27. The existing POST /api/getFile (mammoth conversion) stays, just moved under this module

Phase 7 — Email & Notification Service
Replaces: send-email-notification and notification-service Supabase Edge Functions

Tasks: 28. Expand src/modules/email/email.service.js to support all templates: submission_received, review_assigned, decision_made, article_published, payment_confirmed, sendReceipt, etc. 29. POST /api/notifications/send — internal endpoint that sends email + inserts email_notifications record via Prisma

Phase 8 — Integrations (Edge Function Replacements)
Replaces: Supabase Edge Functions for external API integrations

Tasks: 30. Zenodo DOI — POST /api/doi/generate — replaces generate-zenodo-doi edge function 31. DOAJ submission — POST /api/doaj/submit and POST /api/doaj/bulk — replaces bulk-submit-doaj 32. OAI-PMH endpoint — GET /api/oai — replaces oai-pmh-endpoint edge function 33. Data export — GET /api/export?format=csv|excel&dateFrom=&dateTo= — replaces export-data 34. AJOL metadata export — GET /api/export/ajol — replaces export-ajol-metadata

Phase 9 — Analytics
Replaces: aggregation queries done directly in frontend components

Tasks: 35. GET /api/analytics/overview — submission counts, acceptance rates, turnaround times 36. GET /api/analytics/reviewer-performance — per-reviewer metrics 37. GET /api/analytics/editorial — decision breakdown stats

Scope Summary
Phase Tasks Replaces
1 — Foundation 1–4 Prisma setup, middleware
2 — Auth 5–10 supabase.auth.\*
3 — Core Data 11–17 Direct table calls (submissions, articles, reviews…)
4 — Communication 18–21 discussions, notifications, realtime
5 — Content 22–23 blog_posts, partners
6 — File/Storage 24–27 Supabase Storage
7 — Email 28–29 notification-service edge function
8 — Integrations 30–34 5 edge functions (Zenodo, DOAJ, OAI-PMH, exports)
9 — Analytics 35–37 Frontend aggregation queries
