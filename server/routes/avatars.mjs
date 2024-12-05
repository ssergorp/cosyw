import express from 'express';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';

const router = express.Router();

// Thumbnail generation
const THUMB_DIR = './public/thumbnails';
const THUMB_SIZE = 128;

// Export these functions so they can be used by other modules
export async function ensureThumbnailDir() {
  try {
    await fs.access(THUMB_DIR);
  } catch {
    await fs.mkdir(THUMB_DIR, { recursive: true });
  }
}

export async function generateThumbnail(imageUrl) {
  const hash = crypto.createHash('md5').update(imageUrl).digest('hex');
  const thumbnailPath = path.join(THUMB_DIR, `${hash}.webp`);
  
  try {
    // Check if thumbnail already exists
    await fs.access(thumbnailPath);
    return `/thumbnails/${hash}.webp`;
  } catch {
    // Generate thumbnail
    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();
    await sharp(Buffer.from(buffer))
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
      .webp({ quality: 80 })
      .toFile(thumbnailPath);
    return `/thumbnails/${hash}.webp`;
  }
}

export default function(db) {
  // Get paginated avatars with thumbnails
  router.get('/', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = ((page - 1) * limit) + 1;

      const [avatars, total] = await Promise.all([
        db.collection('avatars')
          .find({})
          .sort({ emoji: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        db.collection('avatars').countDocuments()
      ]);

      // Generate thumbnails in parallel
      await ensureThumbnailDir();
      const avatarsWithThumbs = await Promise.all(
        avatars.map(async (avatar) => ({
          ...avatar,
          thumbnailUrl: await generateThumbnail(avatar.imageUrl)
        }))
      );

      res.json({
        avatars: avatarsWithThumbs,
        total,
        page,
        totalPages: Math.ceil(total / limit)
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}