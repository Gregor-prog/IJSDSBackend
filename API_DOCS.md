# IJSDS Backend — API Documentation

**Base URL:** `https://api.ijsds.org` (or `http://localhost:8080` for local dev)
**Content-Type:** `application/json` for all requests except file uploads
**Auth:** Bearer token in `Authorization` header — `Authorization: Bearer <token>`

---

## Response Envelope

All endpoints return a consistent envelope:

```json
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "message": "Human-readable error message" }
```

---

## Authentication

### POST /auth/register

Create a new account. Returns a JWT token immediately.

**Auth required:** No

**Request body:**

```json
{
  "full_name": "Jane Doe",
  "email": "jane@example.com",
  "password": "Min8chars!"
}
```

**200 Success:**

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGci...",
    "profile": {
      "id": "uuid",
      "full_name": "Jane Doe",
      "email": "jane@example.com",
      "role": "author",
      "is_editor": false,
      "is_reviewer": false,
      "is_admin": false
    }
  }
}
```

**409 Email already exists:**

```json
{ "success": false, "message": "An account with this email already exists" }
```

---

### POST /auth/login

**Auth required:** No

**Request body:**

```json
{
  "email": "jane@example.com",
  "password": "Min8chars!"
}
```

**200 Success:**

```json
{
  "success": true,
  "token": "eyJhbGci...",
  "profile": {
    "id": "uuid",
    "full_name": "Jane Doe",
    "email": "jane@example.com",
    "role": "author",
    "is_editor": false,
    "is_reviewer": false,
    "is_admin": false,
    "affiliation": null,
    "orcid_id": null
  }
}
```

**401 Invalid credentials:**

```json
{ "success": false, "message": "Invalid email or password" }
```

---

### GET /auth/me

Returns the currently authenticated user's profile.

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "full_name": "Jane Doe",
    "email": "jane@example.com",
    "role": "author",
    "affiliation": "University of Lagos",
    "orcid_id": "0000-0001-2345-6789",
    "bio": null,
    "is_editor": false,
    "is_reviewer": true,
    "is_admin": false,
    "email_notifications_enabled": true,
    "deadline_reminder_days": 3
  }
}
```

**401 Unauthorized:**

```json
{ "success": false, "message": "No token provided" }
```

---

### POST /auth/logout

Invalidates the current token.

**Auth required:** Yes

**200 Success:**

```json
{ "success": true, "message": "Logged out successfully" }
```

---

### POST /auth/forgot-password

Sends a password reset email.

**Auth required:** No

**Request body:**

```json
{ "email": "jane@example.com" }
```

**200 Success** (same response whether email exists or not — prevents user enumeration):

```json
{
  "success": true,
  "message": "If an account with that email exists, a reset link has been sent."
}
```

---

### POST /auth/reset-password

**Auth required:** No

**Request body:**

```json
{
  "token": "reset-token-from-email",
  "password": "NewPassword123!"
}
```

**200 Success:**

```json
{ "success": true, "message": "Password updated successfully" }
```

**400 Invalid/expired token:**

```json
{ "success": false, "message": "Invalid or expired reset token" }
```

---

### GET /auth/orcid/login

Redirects to ORCID OAuth login page. Open in browser — not a JSON endpoint.

### GET /auth/orcid/callback

Handled server-side. On success, redirects to:

```
https://www.ijsds.org/auth/callback?token=<jwt>
```

Frontend should read the `token` query param on this page and store it.

---

## Profiles

### GET /api/profiles

List all profiles (find reviewers/editors).

**Auth required:** Yes — `editor` or `admin` role

**Query params:** `role`, `is_reviewer`, `is_editor` (all optional)

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "full_name": "Dr. Emeka Ike",
      "email": "emeka@example.com",
      "affiliation": "University of Lagos",
      "orcid_id": null,
      "is_editor": true,
      "is_reviewer": true,
      "role": "editor"
    }
  ]
}
```

---

### GET /api/profiles/:id

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "full_name": "Jane Doe",
    "email": "jane@example.com",
    "affiliation": null,
    "orcid_id": null,
    "bio": null,
    "is_editor": false,
    "is_reviewer": false,
    "is_admin": false,
    "email_notifications_enabled": true,
    "deadline_reminder_days": 3,
    "request_reviewer": false,
    "request_editor": false,
    "role": "author"
  }
}
```

---

### PATCH /api/profiles/:id

Update a profile. Users can only update their own profile unless admin.

**Auth required:** Yes

**Request body** (all fields optional):

```json
{
  "full_name": "Jane Smith",
  "affiliation": "University of Ibadan",
  "bio": "Social work researcher...",
  "orcid_id": "0000-0001-2345-6789",
  "email_notifications_enabled": false,
  "deadline_reminder_days": 5,
  "request_reviewer": true,
  "request_editor": false
}
```

**200 Success:**

```json
{
  "success": true,
  "data": {
    /* updated profile */
  }
}
```

**403 Forbidden:**

```json
{ "success": false, "message": "Insufficient permissions" }
```

---

## Article

### GET /api/articles

List articles. Public endpoint — no auth required.

**Query params** (all optional):
| Param | Type | Example |
|-------|------|---------|
| `status` | string | `published`, `under_review`, `accepted` |
| `subject_area` | string | `Social Work` |
| `volume` | number | `1` |
| `issue` | number | `2` |

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "title": "Family Therapy Intervention...",
      "abstract": "This study examined...",
      "keywords": ["social work", "family therapy"],
      "authors": [
        {
          "name": "Dr. Jane Doe",
          "email": "jane@example.com",
          "affiliation": "University of Lagos",
          "orcid": "0000-0001-2345-6789"
        }
      ],
      "corresponding_author_email": "jane@example.com",
      "doi": "10.5281/zenodo.123456",
      "status": "published",
      "volume": 1,
      "issue": 1,
      "page_start": 1,
      "page_end": 15,
      "subject_area": "Social Work",
      "publication_date": "2025-10-21T18:12:09.957Z",
      "submission_date": "2025-08-30T13:58:59.117Z",
      "vetting_fee": true,
      "processing_fee": true
    }
  ]
}
```

---

### GET /api/articles/:id

Get a single article with its submission history and file versions.

**Auth required:** No

**200 Success:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "title": "...",
    "abstract": "...",
    "keywords": [],
    "authors": [],
    "doi": null,
    "status": "submitted",
    "submissions": [
      {
        "id": "uuid",
        "status": "accepted",
        "submitted_at": "2025-09-06T...",
        "submitter_id": "uuid"
      }
    ],
    "file_versions": [
      {
        "id": "uuid",
        "file_url": "https://...",
        "file_name": "manuscript.docx",
        "file_type": "manuscript",
        "version_number": 1,
        "is_supplementary": false,
        "is_archived": false
      }
    ]
  }
}
```

---

### PATCH /api/articles/:id

Update article metadata. Editors/admins only.

**Auth required:** Yes — `editor` or `admin`

**Request body** (all fields optional):

```json
{
  "title": "Updated Title",
  "abstract": "Updated abstract...",
  "keywords": ["keyword1", "keyword2"],
  "doi": "10.5281/zenodo.123456",
  "status": "published",
  "volume": 1,
  "issue": 1,
  "page_start": 1,
  "page_end": 20,
  "subject_area": "Social Work",
  "publication_date": "2025-10-21T00:00:00Z",
  "vetting_fee": true,
  "processing_fee": true
}
```

**200 Success:**

```json
{
  "success": true,
  "data": {
    /* updated article */
  }
}
```

---

## Submissions

All submission endpoints require authentication.

### GET /api/submissions

**Auth required:** Yes

Returns submissions scoped to the user's role:

- `author` → only their own submissions
- `editor` / `admin` → all submissions

**Query params** (all optional):
| Param | Type | Example |
|-------|------|---------|
| `status` | string | `submitted`, `under_review`, `accepted`, `rejected`, `revision_requested` |
| `submitter_id` | uuid | Filter by specific author |

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "article_id": "uuid",
      "submitter_id": "uuid",
      "submission_type": "new",
      "status": "under_review",
      "cover_letter": "Dear Editor...",
      "reviewer_suggestions": null,
      "submitted_at": "2025-09-06T16:19:59.651Z",
      "vetting_fee": false,
      "processing_fee": false,
      "article": { "id": "uuid", "title": "...", "status": "under_review" },
      "submitter": {
        "id": "uuid",
        "full_name": "Jane Doe",
        "email": "jane@example.com"
      }
    }
  ]
}
```

---

### GET /api/submissions/:id

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "article_id": "uuid",
    "submitter_id": "uuid",
    "submission_type": "new",
    "status": "under_review",
    "cover_letter": "Dear Editor...",
    "reviewer_suggestions": "Dr. Smith at University of Lagos",
    "editor_notes": null,
    "approved_by_editor": false,
    "approved_at": null,
    "submitted_at": "2025-09-06T16:19:59.651Z",
    "article": {
      /* article object */
    },
    "submitter": {
      /* profile object */
    },
    "reviews": [
      /* review objects */
    ]
  }
}
```

---

### POST /api/submissions

Create a new submission. The article and submission are created together.

**Auth required:** Yes

**Request body:**

```json
{
  "title": "Effectiveness of Social Casework Methods...",
  "abstract": "This study examined...",
  "keywords": ["social work", "juvenile delinquency"],
  "authors": [
    {
      "name": "Dr. Jane Doe",
      "email": "jane@example.com",
      "affiliation": "University of Lagos",
      "orcid": "0000-0001-2345-6789"
    }
  ],
  "corresponding_author_email": "jane@example.com",
  "subject_area": "Social Work",
  "cover_letter": "Dear Editor, I am submitting...",
  "reviewer_suggestions": "Dr. Smith at UNILAG",
  "submission_type": "new",
  "funding_info": null,
  "conflicts_of_interest": null
}
```

**201 Created:**

```json
{
  "success": true,
  "data": {
    "submission": {
      "id": "uuid",
      "status": "submitted",
      "submitted_at": "2026-03-26T10:00:00Z"
    },
    "article": {
      "id": "uuid",
      "title": "Effectiveness of Social Casework Methods..."
    }
  }
}
```

---

### PATCH /api/submissions/:id

Update submission status or editor notes.

**Auth required:** Yes — authors can update their own; editors/admins can update all

**Request body** (all fields optional):

```json
{
  "status": "under_review",
  "editor_notes": "Sent to two reviewers",
  "approved_by_editor": true,
  "vetting_fee": true,
  "processing_fee": false
}
```

**Allowed status values:** `submitted` → `under_review` → `revision_requested` → `accepted` → `rejected`

**200 Success:**

```json
{
  "success": true,
  "data": {
    /* updated submission */
  }
}
```

---

## Reviews

### GET /api/reviews

**Auth required:** Yes

Returns reviews scoped to role:

- `reviewer` → only their own reviews
- `editor` / `admin` → all reviews

**Query params** (all optional): `submission_id`, `reviewer_id`, `invitation_status`

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "submission_id": "uuid",
      "reviewer_id": "uuid",
      "recommendation": "accept",
      "invitation_status": "accepted",
      "review_round": 1,
      "deadline_date": "2025-09-23T00:00:00Z",
      "submitted_at": null,
      "reviewer": {
        "id": "uuid",
        "full_name": "Dr. Smith",
        "email": "smith@example.com"
      }
    }
  ]
}
```

---

### GET /api/reviews/:id

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "submission_id": "uuid",
    "reviewer_id": "uuid",
    "recommendation": "minor_revisions",
    "comments_to_author": "The paper is well-structured but...",
    "comments_to_editor": "I recommend minor revisions...",
    "review_file_url": "https://...",
    "conflict_of_interest_declared": false,
    "review_round": 1,
    "invitation_status": "accepted",
    "deadline_date": "2025-09-23T00:00:00Z",
    "submitted_at": "2025-09-20T14:30:00Z"
  }
}
```

---

### POST /api/reviews

Invite a reviewer to review a submission.

**Auth required:** Yes — `editor` or `admin`

**Request body:**

```json
{
  "submission_id": "uuid",
  "reviewer_id": "uuid",
  "deadline_date": "2025-09-23T00:00:00Z",
  "review_round": 1
}
```

**201 Created:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "submission_id": "uuid",
    "reviewer_id": "uuid",
    "invitation_status": "pending",
    "deadline_date": "2025-09-23T00:00:00Z"
  }
}
```

---

### PATCH /api/reviews/:id

Accept/decline invitation, or submit a completed review.

**Auth required:** Yes

**Request body** (all fields optional):

```json
{
  "invitation_status": "accepted",
  "recommendation": "minor_revisions",
  "comments_to_author": "The paper is well-structured but...",
  "comments_to_editor": "I recommend minor revisions...",
  "conflict_of_interest_declared": false,
  "conflict_of_interest_details": null
}
```

**Recommendation values:** `accept`, `minor_revisions`, `major_revisions`, `reject`

**200 Success:**

```json
{
  "success": true,
  "data": {
    /* updated review */
  }
}
```

---

## Editorial Decisions

### GET /api/editorial-decisions/:submissionId

**Auth required:** Yes — `editor` or `admin`

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "submission_id": "uuid",
      "editor_id": "uuid",
      "decision_type": "send_for_review",
      "decision_rationale": "Paper meets scope requirements",
      "created_at": "2025-09-10T09:00:00Z"
    }
  ]
}
```

---

### POST /api/editorial-decisions

**Auth required:** Yes — `editor` or `admin`

**Request body:**

```json
{
  "submission_id": "uuid",
  "decision_type": "accept",
  "decision_rationale": "Excellent contribution to the field."
}
```

**Decision type values:** `desk_reject`, `send_for_review`, `accept`, `reject`, `minor_revision`, `major_revision`

**201 Created:**

```json
{
  "success": true,
  "data": {
    /* decision object */
  }
}
```

---

## Revision Requests

### GET /api/revision-requests/:submissionId

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "submission_id": "uuid",
      "requested_by": "uuid",
      "revision_type": "minor",
      "request_details": "Please address reviewer comments on methodology.",
      "deadline_date": "2025-11-01T00:00:00Z",
      "created_at": "2025-10-01T00:00:00Z"
    }
  ]
}
```

---

### POST /api/revision-requests

**Auth required:** Yes — `editor` or `admin`

**Request body:**

```json
{
  "submission_id": "uuid",
  "revision_type": "minor",
  "request_details": "Please address the reviewer comments on the methodology section.",
  "deadline_date": "2025-11-01T00:00:00Z"
}
```

**Revision type values:** `minor`, `major`

**201 Created:**

```json
{
  "success": true,
  "data": {
    /* revision request object */
  }
}
```

---

## Rejection Messages

### GET /api/rejection-messages/:submissionId

**Auth required:** Yes — `editor` or `admin`

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "submission_id": "uuid",
      "message": "We regret to inform you...",
      "suggested_corrections": "Consider revising the methodology.",
      "created_by": "uuid",
      "created_at": "2025-10-01T00:00:00Z"
    }
  ]
}
```

---

### POST /api/rejection-messages

**Auth required:** Yes — `editor` or `admin`

**Request body:**

```json
{
  "submission_id": "uuid",
  "message": "We regret to inform you that your submission does not meet our current scope.",
  "suggested_corrections": "You may wish to revise and submit to a different journal."
}
```

**201 Created:**

```json
{
  "success": true,
  "data": {
    /* rejection message object */
  }
}
```

---

## Discussions

### GET /api/discussions/:submissionId

Get all discussion threads for a submission.

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "submission_id": "uuid",
      "title": "Query about methodology",
      "created_by": "uuid",
      "created_at": "2025-09-15T10:00:00Z",
      "_count": { "messages": 3 }
    }
  ]
}
```

---

### POST /api/discussions

Create a new discussion thread.

**Auth required:** Yes

**Request body:**

```json
{
  "submission_id": "uuid",
  "title": "Query about methodology section"
}
```

**201 Created:**

```json
{
  "success": true,
  "data": {
    /* thread object */
  }
}
```

---

### GET /api/discussions/:threadId/messages

Get all messages in a thread.

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "thread_id": "uuid",
      "author_id": "uuid",
      "content": "Could you clarify the sampling method?",
      "created_at": "2025-09-15T10:05:00Z"
    }
  ]
}
```

---

### POST /api/discussions/:threadId/messages

Post a message to a thread.

**Auth required:** Yes

**Request body:**

```json
{ "content": "The sampling method used was purposive sampling because..." }
```

**201 Created:**

```json
{
  "success": true,
  "data": {
    /* message object */
  }
}
```

---

## Notifications

### GET /api/notifications

Get all notifications for the authenticated user.

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "title": "Review Invitation",
      "message": "You have been invited to review a submission.",
      "type": "info",
      "read": false,
      "created_at": "2025-09-02T19:13:59Z"
    }
  ]
}
```

---

### GET /api/notifications/stream

Real-time notification stream using **Server-Sent Events (SSE)**.

**Auth required:** Yes

**Usage:**

```javascript
const evtSource = new EventSource(
  "https://api.ijsds.org/api/notifications/stream",
  { headers: { Authorization: `Bearer ${token}` } },
);

evtSource.addEventListener("notification", (e) => {
  const notification = JSON.parse(e.data);
  // { id, title, message, type }
});

// Keep-alive heartbeat arrives every 30s:
evtSource.addEventListener("heartbeat", () => {});
```

---

### PATCH /api/notifications/:id/read

Mark a single notification as read.

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": {
    /* updated notification */
  }
}
```

---

### PATCH /api/notifications/read-all

Mark all notifications as read.

**Auth required:** Yes

**200 Success:**

```json
{ "success": true, "message": "All notifications marked as read" }
```

---

### POST /api/notifications/send

Send an email notification + create an in-app notification. Internal use (editors/admins).

**Auth required:** Yes — `editor` or `admin`

**Request body:**

```json
{
  "template": "review_assigned",
  "to": "reviewer@example.com",
  "recipient_id": "uuid",
  "submission_id": "uuid",
  "data": {
    "reviewer_name": "Dr. Smith",
    "article_title": "Family Therapy...",
    "deadline": "2025-09-23"
  },
  "in_app": true,
  "in_app_title": "New Review Assignment",
  "in_app_message": "You have been assigned to review a new submission."
}
```

**Available template values:** `user_welcome`, `author_welcome`, `submission_received`, `fee_information`, `review_assigned`, `decision_made`, `submission_accepted`, `article_published`, `payment_confirmed`, `payment_received_editor`, `payment_pending_editor`, `send_receipt`

**200 Success:**

```json
{ "success": true, "message": "Notification sent" }
```

---

## File Uploads

### POST /api/files/upload

Upload a manuscript or supplementary file. Accepts `.pdf`, `.doc`, `.docx` — max 10MB.

**Auth required:** Yes

**Request:** `multipart/form-data`

| Field              | Type    | Required | Description                 |
| ------------------ | ------- | -------- | --------------------------- |
| `file`             | File    | Yes      | The document file           |
| `article_id`       | string  | Yes      | UUID of the article         |
| `file_description` | string  | No       | Description of this version |
| `is_supplementary` | boolean | No       | Default: `false`            |

**201 Created:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "article_id": "uuid",
    "file_url": "/uploads/uuid-filename.docx",
    "file_name": "manuscript.docx",
    "file_type": "docx",
    "version_number": 2,
    "is_supplementary": false,
    "is_archived": false,
    "file_size": 204800
  }
}
```

**400 Invalid file type:**

```json
{ "success": false, "message": "Only PDF, DOC, and DOCX files are allowed" }
```

---

### GET /api/files/:articleId

List all file versions for an article.

**Auth required:** Yes

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "article_id": "uuid",
      "file_url": "/uploads/uuid-manuscript.docx",
      "file_name": "manuscript.docx",
      "file_type": "docx",
      "version_number": 1,
      "is_supplementary": false,
      "is_archived": false,
      "created_at": "2025-09-08T15:41:44Z"
    }
  ]
}
```

---

### DELETE /api/files/:id

Delete a file version (removes from disk and database).

**Auth required:** Yes

**200 Success:**

```json
{ "success": true, "message": "File deleted" }
```

---

### POST /api/files/convert

Convert a `.docx` file URL to HTML (for in-browser preview).

**Auth required:** Yes

**Request body:**

```json
{ "url": "https://storage.example.com/manuscript.docx" }
```

**200 Success:**

```json
{
  "success": true,
  "data": { "html": "<h1>Title</h1><p>Content...</p>" }
}
```

---

## Blog

### GET /api/blog

List all published blog posts. Public.

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "title": "Call for Papers — Volume 2",
      "excerpt": "We invite researchers to submit...",
      "slug": "call-for-papers-volume-2",
      "category": "Announcements",
      "tags": ["call-for-papers", "volume-2"],
      "status": "published",
      "published_at": "2025-09-01T00:00:00Z",
      "author": { "id": "uuid", "full_name": "Editorial Team" }
    }
  ]
}
```

---

### GET /api/blog/slug/:slug

Get a single published post by slug. Public.

**200 Success:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "title": "Call for Papers — Volume 2",
    "content": "<p>Full HTML content...</p>",
    "excerpt": "We invite researchers...",
    "slug": "call-for-papers-volume-2",
    "featured_image_url": "https://...",
    "category": "Announcements",
    "tags": ["call-for-papers"],
    "published_at": "2025-09-01T00:00:00Z",
    "author": { "id": "uuid", "full_name": "Editorial Team" }
  }
}
```

**404 Not found:**

```json
{ "success": false, "message": "Post not found" }
```

---

### GET /api/blog/admin

List all posts including drafts.

**Auth required:** Yes — `editor` or `admin`

---

### POST /api/blog

Create a blog post.

**Auth required:** Yes — `editor` or `admin`

**Request body:**

```json
{
  "title": "New Announcement",
  "content": "<p>Full content here...</p>",
  "excerpt": "Short summary...",
  "slug": "new-announcement",
  "category": "Announcements",
  "tags": ["news"],
  "status": "draft",
  "featured_image_url": "https://..."
}
```

**201 Created:**

```json
{
  "success": true,
  "data": {
    /* blog post object */
  }
}
```

---

### PATCH /api/blog/:id

Update a blog post (including publishing: set `status: "published"`).

**Auth required:** Yes — `editor` or `admin`

**Request body** (all fields optional): same as POST.

---

### DELETE /api/blog/:id

**Auth required:** Yes — `editor` or `admin`

**200 Success:**

```json
{ "success": true, "message": "Post deleted" }
```

---

## Partners

### GET /api/partners

List all active partners. Public.

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "Track To Train International",
      "logo_url": "https://res.cloudinary.com/...",
      "website_url": null,
      "description": "Prof. SN Sharma, Research Head...",
      "is_active": true,
      "display_order": 1
    }
  ]
}
```

---

### POST /api/partners

**Auth required:** Yes — `admin`

**Request body:**

```json
{
  "name": "African Studies Institute",
  "logo_url": "https://...",
  "website_url": "https://asi.org",
  "description": "Leading research body...",
  "display_order": 2
}
```

---

### PATCH /api/partners/:id

**Auth required:** Yes — `admin`

**Request body** (all fields optional): same as POST, plus `is_active: false` to hide.

---

### DELETE /api/partners/:id

**Auth required:** Yes — `admin`

---

## Analytics

All analytics endpoints require `editor` or `admin` role.

**Auth required:** Yes — `editor` or `admin`

**Common query params:** `date_from` and `date_to` (ISO date strings, optional)

---

### GET /api/analytics/overview

**200 Success:**

```json
{
  "success": true,
  "data": {
    "submissions_by_status": {
      "submitted": 5,
      "under_review": 8,
      "revision_requested": 2,
      "accepted": 10,
      "rejected": 3
    },
    "acceptance_rate": 55.6,
    "rejection_rate": 16.7,
    "published_articles": 12,
    "active_reviewers": 7,
    "avg_turnaround_days": 34,
    "monthly_trend": [
      { "month": "2025-09", "count": 3 },
      { "month": "2025-10", "count": 5 }
    ]
  }
}
```

---

### GET /api/analytics/reviewer-performance

**200 Success:**

```json
{
  "success": true,
  "data": [
    {
      "reviewer_id": "uuid",
      "full_name": "Dr. Smith",
      "email": "smith@example.com",
      "total_invitations": 10,
      "accepted": 8,
      "declined": 1,
      "pending": 1,
      "acceptance_rate": 88.9,
      "completed_reviews": 6,
      "avg_turnaround_days": 12,
      "on_time_rate": 83.3,
      "recommendations": {
        "accept": 2,
        "minor_revisions": 3,
        "major_revisions": 1,
        "reject": 0
      }
    }
  ]
}
```

---

### GET /api/analytics/editorial

**200 Success:**

```json
{
  "success": true,
  "data": {
    "decision_breakdown": {
      "desk_reject": 3,
      "send_for_review": 15,
      "accept": 10,
      "reject": 5,
      "minor_revision": 4,
      "major_revision": 2
    },
    "avg_days_to_first_decision": 7,
    "revision_to_acceptance_rate": 62.5,
    "per_editor": [
      {
        "editor_id": "uuid",
        "full_name": "Dr. Editor",
        "total_decisions": 12,
        "desk_rejects": 2,
        "accepts": 5,
        "rejects": 3
      }
    ]
  }
}
```

---

## Integrations

### POST /api/doi/generate

Generate a Zenodo DOI for a published article.

**Auth required:** Yes — `editor` or `admin`

**Request body:**

```json
{
  "article_id": "uuid"
}
```

**200 Success:**

```json
{
  "success": true,
  "data": {
    "doi": "10.5281/zenodo.123456",
    "zenodo_record_id": "123456",
    "article": {
      /* updated article with doi */
    }
  }
}
```

---

### POST /api/doaj/submit

Submit a single article to DOAJ.

**Auth required:** Yes — `editor` or `admin`

**Request body:**

```json
{ "article_id": "uuid" }
```

**200 Success:**

```json
{ "success": true, "message": "Article submitted to DOAJ" }
```

---

### POST /api/doaj/bulk

Submit all published articles with a DOI to DOAJ.

**Auth required:** Yes — `editor` or `admin`

**200 Success:**

```json
{
  "success": true,
  "data": {
    "submitted": 8,
    "failed": 1,
    "errors": [{ "article_id": "uuid", "error": "Missing required metadata" }]
  }
}
```

---

### GET /api/oai

OAI-PMH protocol endpoint. Public. Returns XML.

**Query params:**
| Param | Required | Values |
|-------|----------|--------|
| `verb` | Yes | `Identify`, `ListMetadataFormats`, `ListRecords`, `GetRecord` |
| `metadataPrefix` | For ListRecords/GetRecord | `oai_dc` |
| `identifier` | For GetRecord | `oai:ijsds.org:<article_id>` |

**Example:**

```
GET /api/oai?verb=ListRecords&metadataPrefix=oai_dc
GET /api/oai?verb=GetRecord&identifier=oai:ijsds.org:uuid&metadataPrefix=oai_dc
```

---

### GET /api/export

Export data as CSV.

**Auth required:** Yes — `editor` or `admin`

**Query params:**
| Param | Required | Values |
|-------|----------|--------|
| `dataType` | Yes | `submissions`, `reviews`, `articles`, `users` |
| `format` | No | `csv` (default) |
| `dateFrom` | No | ISO date string |
| `dateTo` | No | ISO date string |

Response: CSV file download (`Content-Disposition: attachment; filename="export.csv"`)

---

### GET /api/export/ajol

Export article metadata for AJOL indexing.

**Auth required:** Yes — `editor` or `admin`

**Query params:** `format=xml` (default) or `format=json`

---

## Payments

### POST /api/payment/webhook

Paystack webhook endpoint. Called by Paystack — not by frontend.

---

## Error Reference

| HTTP Code | Meaning                                         |
| --------- | ----------------------------------------------- |
| `400`     | Bad request — missing or invalid fields         |
| `401`     | Unauthenticated — missing or invalid token      |
| `403`     | Forbidden — authenticated but insufficient role |
| `404`     | Resource not found                              |
| `409`     | Conflict — e.g. email already exists            |
| `500`     | Server error                                    |

---

## Roles Reference

| Role       | Description                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `author`   | Default role. Can submit articles, view own submissions, manage own profile |
| `reviewer` | Can view assigned reviews, accept/decline invitations, submit reviews       |
| `editor`   | Full access to submissions, reviews, decisions, analytics, export           |
| `admin`    | All editor permissions + partner/blog management, user role management      |

Roles are set server-side. To request a role change, a user can set `request_reviewer: true` or `request_editor: true` via `PATCH /api/profiles/:id`.
