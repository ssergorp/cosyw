
import express from 'express';
import { ObjectId } from 'mongodb';

export default function(db) {
  const router = express.Router();

  // Get all family roots (avatars with no parents)
  router.get('/', async (req, res) => {
    try {
      const families = await db.collection('avatars')
        .find({ parentEmoji: { $exists: false }, emoji: { $exists: true } })
        .toArray();
      res.json(families);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get family members by emoji
  router.get('/:emoji/members', async (req, res) => {
    try {
      const { emoji } = req.params;
      const members = await db.collection('avatars')
        .find({ 
          $or: [
            { emoji },
            { parentEmoji: emoji }
          ]
        })
        .toArray();
      res.json(members);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}