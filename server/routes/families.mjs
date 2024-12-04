import express from 'express';
import { ObjectId } from 'mongodb';
import { generateThumbnail, ensureThumbnailDir } from './avatars.mjs';

const router = express.Router();

export default function(db) {
  // Get all family roots (avatars with no parents)
  router.get('/', async (req, res) => {
    try {
      await ensureThumbnailDir();
      
      const maxDepth = parseInt(req.query.maxDepth) || 999;

      const pipeline = [
        {
          $match: {
            $or: [
              { parents: { $exists: false } },
              { parents: { $size: 0 } }
            ]
          }
        },
        {
          $graphLookup: {
            from: 'avatars',
            startWith: '$_id',
            connectFromField: '_id',
            connectToField: 'parents',
            as: 'descendants',
            maxDepth: maxDepth - 1
          }
        },
        {
          $match: {
            $expr: { 
              $gt: [{ $size: '$descendants' }, 0] // Only show families with descendants
            }
          }
        }
      ];

      const families = await db.collection('avatars').aggregate(pipeline).toArray();

      // Add thumbnails and format response
      const familiesWithThumbs = await Promise.all(
        families.map(async (family) => ({
          ...family,
          thumbnailUrl: await generateThumbnail(family.imageUrl),
          descendants: await Promise.all(
            family.descendants.map(async (member) => ({
              ...member,
              thumbnailUrl: await generateThumbnail(member.imageUrl)
            }))
          )
        }))
      );

      res.json(familiesWithThumbs);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get specific family by emoji
  router.get('/:emoji', async (req, res) => {
    try {
      const { emoji } = req.params;
      const family = await db.collection('avatars').findOne({ emoji });
      if (!family) {
        return res.status(404).json({ error: 'Family not found' });
      }

      const members = await db.collection('avatars')
        .find({ parentEmoji: emoji })
        .toArray();

      // Add thumbnails
      const familyWithThumbs = {
        ...family,
        thumbnailUrl: await generateThumbnail(family.imageUrl),
        members: await Promise.all(
          members.map(async (member) => ({
            ...member,
            thumbnailUrl: await generateThumbnail(member.imageUrl)
          }))
        )
      };

      res.json(familyWithThumbs);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}