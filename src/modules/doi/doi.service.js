import prisma from "../../config/prisma.js";

const ZENODO_API_URL = process.env.ZENODO_API_URL ?? "https://zenodo.org/api";

// Zenodo rejects filenames over ~100 chars or containing special characters
const toSafeFilename = (title) => {
  const slug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 45)
    .replace(/-$/, "");
  return `${slug || "manuscript"}.pdf`;
};

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
        const full =
          a?.name ??
          (last || first ? `${last}${last && first ? ", " : ""}${first}` : "");
        return full?.trim()
          ? { name: full.trim(), affiliation: a?.affiliation ?? "" }
          : null;
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
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create Zenodo deposition (${res.status}): ${body}`);
    }
    return { deposition: await res.json(), isNewVersion: false };
  }

  // Find concept record
  const initialId = extractZenodoId(existingDoi);
  const recordRes = await fetch(`${ZENODO_API_URL}/records/${initialId}`);
  if (!recordRes.ok) {
    const body = await recordRes.text();
    throw new Error(`Record not found for DOI ${existingDoi} (${recordRes.status}): ${body}`);
  }
  const { conceptrecid } = await recordRes.json();

  // Check for existing unsubmitted draft
  const draftRes = await fetch(
    `${ZENODO_API_URL}/deposit/depositions?q=conceptrecid:${conceptrecid}&status=unsubmitted`,
    { headers: zenodoHeaders() },
  );
  const drafts = await draftRes.json();

  if (drafts?.length > 0) {
    return { deposition: drafts[0], isNewVersion: true };
  }

  // Find latest published version and create new version draft
  const searchRes = await fetch(
    `${ZENODO_API_URL}/records/?q=conceptrecid:${conceptrecid}&sort=version&size=1&all_versions=true`,
  );
  const { hits } = await searchRes.json();
  if (!hits?.hits?.length) throw new Error("No published versions found");

  const latestId = hits.hits[0].id;
  const newVersionRes = await fetch(
    `${ZENODO_API_URL}/deposit/depositions/${latestId}/actions/newversion`,
    { method: "POST", headers: zenodoHeaders() },
  );
  if (!newVersionRes.ok) {
    const body = await newVersionRes.text();
    throw new Error(`Failed to create new Zenodo version (${newVersionRes.status}): ${body}`);
  }

  const { links } = await newVersionRes.json();
  const draftRes2 = await fetch(links.latest_draft, {
    headers: zenodoHeaders(),
  });
  return { deposition: await draftRes2.json(), isNewVersion: true };
};

// ── Main service function ─────────────────────────────────────────────────────

export const generateDoi = async ({ articleId, existingDoi }) => {
  if (!process.env.ZENODO_API_TOKEN) {
    throw new Error("ZENODO_API_TOKEN is not configured");
  }

  // Look up the article directly by its ID
  const article = await prisma.article.findUnique({
    where: { id: articleId },
  });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  // Use the article's existing DOI if existingDoi was not explicitly provided
  const doiToUse = existingDoi ?? article.doi ?? null;
  const { deposition, isNewVersion } = await getOrCreateDraft(doiToUse);

  // Delete old files from draft
  if (deposition.files?.length > 0) {
    for (const file of deposition.files) {
      await fetch(
        `${ZENODO_API_URL}/deposit/depositions/${deposition.id}/files/${file.id}`,
        {
          method: "DELETE",
          headers: zenodoHeaders(),
        },
      );
    }
  }

  // Update metadata
  const updateRes = await fetch(
    `${ZENODO_API_URL}/deposit/depositions/${deposition.id}`,
    {
      method: "PUT",
      headers: zenodoHeaders(),
      body: JSON.stringify(buildMetadata(article)),
    },
  );
  if (!updateRes.ok) {
    const err = await updateRes.text();
    throw new Error(`Zenodo metadata update failed: ${err}`);
  }

  // Upload manuscript file if available
  if (article.manuscript_file_url) {
    const fileRes = await fetch(article.manuscript_file_url);
    if (!fileRes.ok) {
      throw new Error(
        `Failed to fetch manuscript file from URL: ${article.manuscript_file_url}`,
      );
    }

    const blob = await fileRes.blob();
    const fileName = toSafeFilename(article.title);
    const form = new FormData();
    form.append("file", blob, fileName);

    const uploadRes = await fetch(
      `${ZENODO_API_URL}/deposit/depositions/${deposition.id}/files`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.ZENODO_API_TOKEN}` },
        body: form,
      },
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`Zenodo file upload failed: ${err}`);
    }
  } else {
    throw new Error("Cannot publish to Zenodo without a manuscript file.");
  }

  // Publish
  const publishRes = await fetch(
    `${ZENODO_API_URL}/deposit/depositions/${deposition.id}/actions/publish`,
    { method: "POST", headers: zenodoHeaders() },
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
