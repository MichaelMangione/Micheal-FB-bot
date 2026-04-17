import fs from 'fs/promises';
import path from 'path';

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;

/**
 * Shared helper: reads and sorts image files from a directory
 */
async function getImageFiles(dir) {
  const resolved = path.resolve(dir);
  console.log('[images] Resolved image dir:', resolved);

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && IMAGE_EXT.test(e.name))
    .map((e) => path.join(resolved, e.name))
    .sort(); // ensures consistent order across runs

  console.log(`[images] Found ${files.length} image(s):`, files);
  return files;
}

/**
 * Pick a random image from the directory
 */
export async function pickRandomImagePath(dir) {
  const files = await getImageFiles(dir);
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}

/**
 * Pick an image using round-robin cycling by postId
 */
export async function pickImageByPostId(dir, postId) {
  const files = await getImageFiles(dir);
  if (!files.length) {
    console.warn('[images] No images found — upload will be skipped');
    return null;
  }

  const imageIndex = (postId - 1) % files.length;
  const selected = files[imageIndex];
  console.log(`[images] postId=${postId} → index=${imageIndex} → ${selected}`);
  return selected;
}