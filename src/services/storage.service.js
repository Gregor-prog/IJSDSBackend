import { supabase } from "../lib/supabase.js";

const BUCKET = process.env.SUPABASE_BUCKET_NAME;

export const StorageService = {
  // Upload a file
  async upload(path, fileBuffer, mimeType) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .upload(path, fileBuffer, { contentType: mimeType, upsert: true });

    if (error) throw new Error(`Upload failed: ${error.message}`);
    return data;
  },

  // Get a public URL (for public buckets)
  getPublicUrl(path) {
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  },

  // Get a signed URL (for private buckets, expires in seconds)
  async getSignedUrl(path, expiresIn = 3600) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, expiresIn);

    if (error) throw new Error(`Signed URL failed: ${error.message}`);
    return data.signedUrl;
  },

  // Delete a file
  async delete(path) {
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) throw new Error(`Delete failed: ${error.message}`);
  },
};
