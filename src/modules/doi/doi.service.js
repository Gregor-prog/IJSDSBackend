import prisma from "../../config/prisma.js";

const ZENODO_API_URL = process.env.ZENODO_API_URL ?? "https://zenodo.org/api";

const zenodoHeaders = () => ({
  Authorization: `Bearer ${process.env.ZENODO_API_TOKEN}`,
  "Content-Type": "application/json",
});

// Extract numeric Zenodo record ID from a DOI string or URL
const extractZenodoId = (doi) => {
  const clean = doi
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^[^/]+\/zenodo\./, "");
  const match = clean.match(/^\d+$/);
  if (!match) throw new Error(`Invalid Zenodo DOI format: ${doi}`);
  return match[0];
};

const buildMetadata = (article) => ({
  metadata: {
    title: article.title,
    description: article.abstract,
    creators: (Array.isArray(article.authors) ? article.authors : [])
      .map((a) => {
        const last = a?.last_name ?? a?.lastName ?? a?.surname ?? "";
        const first = a?.first_name ?? a?.firstName ?? a?.given ?? "";
        const full = a?.name ?? (last || first ? `${last}${last && first ? ", " : ""}${first}` : "");
        return full?.trim() ? { name: full.trim(), affiliation: a?.affiliation ?? "" } : null;
      })
      .filter(Boolean),
    keywords: article.keywords ?? [],
    subjects: article.subject_area ? [{ term: article.subject_area }] : [],
    upload_type: "publication",
    publication_type: "article",
    access_right: "open",
    license: "cc-by-sa-4.0",
  },
});

// ── Get or create a draft deposition ─────────────────────────────────────────

const getOrCreateDraft = async (existingDoi) => {
  if (!existingDoi) {
    const res = await fetch(`${ZENODO_API_URL}/deposit/depositions`, {
      method: "POST",
      headers: zenodoHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error("Failed to create Zenodo deposition");
    return { deposition: await res.json(), isNewVersion: false };
  }

  // Find concept record
  const initialId = extractZenodoId(existingDoi);
  const recordRes = await fetch(`${ZENODO_API_URL}/records/${initialId}`);
  if (!recordRes.ok) throw new Error(`Record not found for DOI: ${existingDoi}`);
  const { conceptrecid } = await recordRes.json();

  // Check for existing unsubmitted draft
  const draftRes = await fetch(
    `${ZENODO_API_URL}/deposit/depositions?q=conceptrecid:${conceptrecid}&status=unsubmitted`,
    { headers: zenodoHeaders() }
  );
  const drafts = await draftRes.json();

  if (drafts?.length > 0) {
    return { deposition: drafts[0], isNewVersion: true };
  }

  // Find latest published version and create new version draft
  const searchRes = await fetch(
    `${ZENODO_API_URL}/records/?q=conceptrecid:${conceptrecid}&sort=version&size=1&all_versions=true`
  );
  const { hits } = await searchRes.json();
  if (!hits?.hits?.length) throw new Error("No published versions found");

  const latestId = hits.hits[0].id;
  const newVersionRes = await fetch(
    `${ZENODO_API_URL}/deposit/depositions/${latestId}/actions/newversion`,
    { method: "POST", headers: zenodoHeaders() }
  );
  if (!newVersionRes.ok) throw new Error("Failed to create new Zenodo version");

  const { links } = await newVersionRes.json();
  const draftRes2 = await fetch(links.latest_draft, { headers: zenodoHeaders() });
  return { deposition: await draftRes2.json(), isNewVersion: true };
};

// ── Main service function ─────────────────────────────────────────────────────

export const generateDoi = async ({ submissionId, existingDoi }) => {
  if (!process.env.ZENODO_API_TOKEN) {
    throw new Error("ZENODO_API_TOKEN is not configured");
  }

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      article: true,
    },
  });

  if (!submission?.article) {
    const err = new Error("Submission or article not found");
    err.status = 404;
    throw err;
  }

  const article = submission.article;
  const { deposition, isNewVersion } = await getOrCreateDraft(existingDoi);

  // Unlock for editing
  await fetch(`${ZENODO_API_URL}/deposit/depositions/${deposition.id}/actions/edit`, {
    method: "POST",
    headers: zenodoHeaders(),
  });

  // Delete old files from draft
  if (deposition.files?.length > 0) {
    for (const file of deposition.files) {
      await fetch(`${ZENODO_API_URL}/deposit/depositions/${deposition.id}/files/${file.id}`, {
        method: "DELETE",
        headers: zenodoHeaders(),
      });
    }
  }

  // Update metadata
  await fetch(`${ZENODO_API_URL}/deposit/depositions/${deposition.id}`, {
    method: "PUT",
    headers: zenodoHeaders(),
    body: JSON.stringify(buildMetadata(article)),
  });

  // Upload manuscript file if available
  if (article.manuscript_file_url) {
    try {
      const fileRes = await fetch(article.manuscript_file_url);
      if (fileRes.ok) {
        const blob = await fileRes.blob();
        const fileName = `${article.title.replace(/[^\w\s-]/g, "").trim()}.pdf`;
        const form = new FormData();
        form.append("file", blob, fileName);
        await fetch(`${ZENODO_API_URL}/deposit/depositions/${deposition.id}/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.ZENODO_API_TOKEN}` },
          body: form,
        });
      }
    } catch {
      console.warn("[doi] Manuscript upload skipped — file unreachable");
    }
  }

  // Publish
  const publishRes = await fetch(
    `${ZENODO_API_URL}/deposit/depositions/${deposition.id}/actions/publish`,
    { method: "POST", headers: zenodoHeaders() }
  );
  if (!publishRes.ok) {
    const err = await publishRes.text();
    throw new Error(`Zenodo publish failed: ${err}`);
  }

  const published = await publishRes.json();
  const conceptDoi = published.conceptdoi;
  const versionDoi = published.doi;

  // Persist DOI to article
  await prisma.article.update({
    where: { id: article.id },
    data: { doi: conceptDoi, status: "accepted" },
  });

  return {
    doi: conceptDoi,
    version_doi: versionDoi,
    zenodo_url: published.links.html,
    is_new_version: isNewVersion,
  };
};
