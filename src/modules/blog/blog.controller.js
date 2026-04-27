import {
  listPosts,
  listAllPosts,
  getPostBySlug,
  getPostById,
  createPost,
  updatePost,
  deletePost,
} from "./blog.service.js";
import { uploadImage } from "../../services/cloudinary.service.js";

// Public
export const list = async (req, res, next) => {
  try {
    const { category, tag } = req.query;
    const data = await listPosts({ category, tag });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getBySlug = async (req, res, next) => {
  try {
    const data = await getPostBySlug(req.params.slug);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// Admin — see all posts regardless of status
export const listAdmin = async (req, res, next) => {
  try {
    const { status, category } = req.query;
    const data = await listAllPosts({ status, category });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getById = async (req, res, next) => {
  try {
    const data = await getPostById(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const create = async (req, res, next) => {
  try {
    const data = await createPost(req.body, req.user.id);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const update = async (req, res, next) => {
  try {
    const data = await updatePost(req.params.id, req.body);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const remove = async (req, res, next) => {
  try {
    await deletePost(req.params.id);
    return res.status(200).json({ success: true, message: "Post deleted" });
  } catch (err) {
    next(err);
  }
};

export const uploadFeaturedImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file provided" });
    }
    const { url, public_id } = await uploadImage(req.file.buffer, {
      folder: "ijsds/blog",
    });
    return res.status(200).json({ success: true, url, public_id });
  } catch (err) {
    next(err);
  }
};
