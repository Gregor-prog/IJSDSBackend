# IJSDS Backend — Frontend Change Log

This document covers all breaking changes, new endpoints, and behaviour updates introduced after the initial API documentation (`API_DOCS.md`). Read this alongside the main docs.

---

## 1. Submission File Upload — now `multipart/form-data`

`POST /api/submissions` previously accepted `application/json`. It now accepts `multipart/form-data` because the manuscript file is uploaded in the same request.

**Content-Type:** `multipart/form-data`

**Form fields:**

| Field | Type | Required |
|---|---|---|
| `file` | File (`.pdf`, `.doc`, `.docx`, max 10MB) | No |
| `title` | string | Yes |
| `abstract` | string | Yes |
| `authors` | JSON string (array) | Yes |
| `corresponding_author_email` | string | Yes |
| `keywords` | JSON string (array) | No |
| `subject_area` | string | No |
| `cover_letter` | string | No |
| `reviewer_suggestions` | string | No |
| `submission_type` | `"new"` \| `"revision"` | No (default `"new"`) |
| `funding_info` | string | No |
| `conflicts_of_interest` | string | No |

> `authors` and `keywords` must be sent as JSON strings since the request is `multipart/form-data`:
> ```js
> formData.append("authors", JSON.stringify([{ first_name: "Jane", last_name: "Doe", affiliation: "University of Lagos" }]));
> formData.append("keywords", JSON.stringify(["social work", "policy"]));
> ```

**201 Success:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "article_id": "uuid",
    "submitter_id": "uuid",
    "status": "submitted",
    "submission_type": "new",
    "article": {
      "id": "uuid",
      "title": "...",
      "manuscript_file_url": "https://storage-url/pdfs/filename.pdf"
    },
    "submitter": { "id": "uuid", "full_name": "Jane Doe", "email": "jane@example.com" }
  }
}
```

**Automatic email:** Author receives a `Submission Received` email immediately after creation.

---

## 2. Password Reset Flow

Two new unauthenticated endpoints handle email-based password reset.

### POST /auth/forgot-password

Sends a password reset link to the user's email. Always returns 200 to avoid revealing whether an email is registered.

**Auth required:** No

**Request body:**
```json
{ "email": "jane@example.com" }
```

**200 Response:**
```json
{ "success": true, "message": "If that email is registered, a reset link has been sent" }
```

The email contains a link: `{FRONTEND_URL}/reset-password?token=<token>` (token expires in 1 hour).

---

### POST /auth/reset-password

Consumes the token from the reset link and sets a new password.

**Auth required:** No

**Request body:**
```json
{
  "token": "<token from the reset link query param>",
  "password": "NewPassword123!"
}
```

**200 Success:**
```json
{ "success": true, "message": "Password updated successfully" }
```

**400 Invalid/expired token:**
```json
{ "success": false, "message": "Reset token is invalid or has expired" }
```

> After a successful reset, the user should be redirected to login. The token is single-use.

---

## 3. Blog — Featured Image Upload (Cloudinary)

Images for blog posts are uploaded separately before creating or updating a post. The upload endpoint returns a URL which is then passed as `featured_image_url`.

### POST /api/blog/image

Upload a featured image to Cloudinary.

**Auth required:** Yes — `editor` or `admin` role only

**Content-Type:** `multipart/form-data`

**Form fields:**

| Field | Type | Required |
|---|---|---|
| `image` | Image file (jpg, jpeg, png, webp, gif — max 5MB) | Yes |

**200 Success:**
```json
{
  "success": true,
  "url": "https://res.cloudinary.com/your-cloud/image/upload/v.../ijsds/blog/filename.webp",
  "public_id": "ijsds/blog/filename"
}
```

**400 No file:**
```json
{ "success": false, "message": "No image file provided" }
```

**Typical flow:**
```
1. Upload image  →  POST /api/blog/image          →  { url }
2. Create post   →  POST /api/blog { featured_image_url: url, ... }
```

---

## 4. Payment Verification — now requires auth

`POST /api/payment/verify-payment` now requires a valid JWT.

**Breaking change:** Unauthenticated calls will receive `401 Unauthorized`.

Add `Authorization: Bearer <token>` to the request header.

---

## 5. Automatic Emails — no action required

The following emails are now sent automatically by the backend. The frontend does not need to trigger them:

| Trigger | Recipient | Email |
|---|---|---|
| User registers | New user | Welcome to IJSDS |
| Submission created | Author | Submission Received |
| Editor approves submission (`approved_by_editor: true`) | Author | Submission Accepted for Review |
| Reviewer invited | Reviewer | Review Assignment |
| Editorial decision posted | Author | Editorial Decision (accepted / rejected / revision) |
| Article status set to `published` | Author | Article Published (×2 — standard + congratulatory) |
| Payment webhook confirmed | Author | Payment Confirmed |

---

## 6. DOI Auto-Generation on Accept

When an editorial decision of `"accept"` is posted via `POST /api/editorial-decisions`, the backend automatically:

1. Updates the article status to `"accepted"`
2. Creates a Zenodo deposition, uploads the manuscript, and publishes it
3. Saves the DOI back to the article record

The frontend does not need to call `POST /api/doi/generate` manually for the standard accept flow. The `doi` field on the article will be populated asynchronously — poll `GET /api/articles/:id` if you need to display it immediately.

> Manual DOI generation via `POST /api/doi/generate` is still available for edge cases (re-publishing, corrections).

---

## 7. Submission List — editors see all

`GET /api/submissions` now returns all submissions for users with `role: "editor"` or `role: "admin"`. Authors still only see their own.

The response now includes additional article fields:
```json
"article": {
  "id": "uuid",
  "title": "...",
  "abstract": "...",
  "status": "submitted",
  "doi": null,
  "subject_area": "...",
  "authors": [...],
  "manuscript_file_url": "...",
  "vetting_fee": null,
  "processing_fee": null
}
```

---

## Environment Variables Required by Frontend

These values must be set in your frontend environment:

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` (or equivalent) | Base URL of this backend |
| Redirect to `{BACKEND_URL}/auth/orcid` | ORCID OAuth login entry point |
| Reset link reads `?token=` from URL | Must route `/reset-password` to the reset form |
