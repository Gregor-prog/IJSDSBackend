import { v2 as cloudinary } from "cloudinary";

const getCloudinary = () => {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    throw new Error("Cloudinary credentials are not configured");
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  return cloudinary;
};

/**
 * Upload an image buffer to Cloudinary.
 * Returns the secure URL and public_id.
 */
export const uploadImage = (buffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const cloud = getCloudinary();

    const uploadOptions = {
      folder: options.folder ?? "ijsds/blog",
      resource_type: "image",
      allowed_formats: ["jpg", "jpeg", "png", "webp", "gif"],
      transformation: [{ quality: "auto", fetch_format: "auto" }],
      ...options,
    };

    cloud.uploader
      .upload_stream(uploadOptions, (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, public_id: result.public_id });
      })
      .end(buffer);
  });
};

/**
 * Delete an image from Cloudinary by its public_id.
 */
export const deleteImage = async (publicId) => {
  const cloud = getCloudinary();
  return cloud.uploader.destroy(publicId);
};
