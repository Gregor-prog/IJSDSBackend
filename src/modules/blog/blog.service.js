import prisma from "../../config/prisma.js";

const slugify = (text) =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

export const listPosts = async ({ status, category, tag }) => {
  const where = {};

  // Public callers (no auth) only see published posts
  if (status) {
    where.status = status;
  } else {
    where.status = "published";
  }

  if (category) where.category = category;
  if (tag) where.tags = { has: tag };

  return prisma.blogPost.findMany({
    where,
    select: {
      id: true,
      title: true,
      excerpt: true,
      featured_image_url: true,
      author_id: true,
      category: true,
      tags: true,
      status: true,
      slug: true,
      published_at: true,
      created_at: true,
    },
    orderBy: { published_at: "desc" },
  });
};

export const listAllPosts = async ({ status, category }) => {
  const where = {};
  if (status) where.status = status;
  if (category) where.category = category;

  return prisma.blogPost.findMany({
    where,
    select: {
      id: true,
      title: true,
      excerpt: true,
      featured_image_url: true,
      author_id: true,
      category: true,
      tags: true,
      status: true,
      slug: true,
      published_at: true,
      created_at: true,
      updated_at: true,
    },
    orderBy: { created_at: "desc" },
  });
};

export const getPostBySlug = async (slug) => {
  const post = await prisma.blogPost.findUnique({ where: { slug } });

  if (!post || post.status !== "published") {
    const err = new Error("Post not found");
    err.status = 404;
    throw err;
  }

  return post;
};

export const getPostById = async (id) => {
  const post = await prisma.blogPost.findUnique({ where: { id } });

  if (!post) {
    const err = new Error("Post not found");
    err.status = 404;
    throw err;
  }

  return post;
};

export const createPost = async (data, authorId) => {
  const {
    title, content, excerpt, featured_image_url,
    category, tags, status,
  } = data;

  if (!title || !content) {
    const err = new Error("title and content are required");
    err.status = 400;
    throw err;
  }

  // Generate a unique slug
  let slug = slugify(title);
  const existing = await prisma.blogPost.findUnique({ where: { slug } });
  if (existing) slug = `${slug}-${Date.now()}`;

  const publishedAt = status === "published" ? new Date() : null;

  return prisma.blogPost.create({
    data: {
      title,
      content,
      excerpt,
      featured_image_url,
      author_id: authorId,
      category,
      tags: tags ?? [],
      status: status ?? "draft",
      slug,
      published_at: publishedAt,
    },
  });
};

export const updatePost = async (id, data) => {
  const post = await prisma.blogPost.findUnique({ where: { id } });

  if (!post) {
    const err = new Error("Post not found");
    err.status = 404;
    throw err;
  }

  const {
    title, content, excerpt, featured_image_url,
    category, tags, status, featured_image,
  } = data;

  const updateData = {};
  if (title !== undefined) {
    updateData.title = title;
    // Regenerate slug only if title changes
    let newSlug = slugify(title);
    if (newSlug !== post.slug) {
      const conflict = await prisma.blogPost.findUnique({ where: { slug: newSlug } });
      if (conflict) newSlug = `${newSlug}-${Date.now()}`;
      updateData.slug = newSlug;
    }
  }
  if (content !== undefined) updateData.content = content;
  if (excerpt !== undefined) updateData.excerpt = excerpt;
  if (featured_image_url !== undefined) updateData.featured_image_url = featured_image_url;
  if (category !== undefined) updateData.category = category;
  if (tags !== undefined) updateData.tags = tags;
  if (status !== undefined) {
    updateData.status = status;
    // Set published_at when first publishing
    if (status === "published" && !post.published_at) {
      updateData.published_at = new Date();
    }
  }

  return prisma.blogPost.update({ where: { id }, data: updateData });
};

export const deletePost = async (id) => {
  const post = await prisma.blogPost.findUnique({ where: { id } });

  if (!post) {
    const err = new Error("Post not found");
    err.status = 404;
    throw err;
  }

  await prisma.blogPost.delete({ where: { id } });
};
