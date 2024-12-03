import express from 'express';
import { generateThumbnail, ensureThumbnailDir } from './avatars.mjs';

const router = express.Router();

export default function(db) {
  router.get('/', async (req, res) => {
    try {
      // Ensure thumbnail directory exists
      await ensureThumbnailDir();

      // Use aggregation for better performance
      const tribes = await db.collection('avatars').aggregate([
        {
          $group: {
            _id: '$emoji',
            count: { $sum: 1 },
            avatars: {
              $push: {
                _id: '$_id',
                name: '$name',
                imageUrl: '$imageUrl',
                messageCount: '$messageCount'
              }
            }
          }
        },
        {
          $sort: { count: -1 }
        },
        {
          $project: {
            _id: 1,
            count: 1,
            avatars: { $slice: ['$avatars', 10] }
          }
        }
      ]).toArray();

      // Add thumbnails to avatars
      const tribesWithThumbs = await Promise.all(
        tribes.map(async (tribe) => ({
          ...tribe,
          avatars: await Promise.all(
            tribe.avatars.map(async (avatar) => ({
              ...avatar,
              thumbnailUrl: await generateThumbnail(avatar.imageUrl)
            }))
          )
        }))
      );

      res.json({ tribes: tribesWithThumbs });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/:emoji', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;

      // Ensure thumbnail directory exists
      await ensureThumbnailDir();

      const [tribe, total] = await Promise.all([
        db.collection('avatars')
          .find({ emoji: req.params.emoji })
          .sort({ messageCount: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        db.collection('avatars').countDocuments({ emoji: req.params.emoji })
      ]);

      // Add thumbnails to tribe members
      const tribeWithThumbs = await Promise.all(
        tribe.map(async (avatar) => ({
          ...avatar,
          thumbnailUrl: await generateThumbnail(avatar.imageUrl)
        }))
      );

      res.json({
        tribe: tribeWithThumbs,
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