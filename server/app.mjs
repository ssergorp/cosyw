import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import models from '../src/models.config.mjs';

const app = express();
const port = process.env.PORT || 3080;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const mongoClient = new MongoClient(process.env.MONGO_URI);

// Connect to MongoDB once during server startup
let db;
(async () => {
  try {
    await mongoClient.connect();
    db = mongoClient.db('cosyworld2');
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1); // Exit process with failure
  }
})();

// Remove TIER_THRESHOLDS constant

const getModelRarity = (modelName) => {
  const model = models.find(m => m.model === modelName);
  return model?.rarity || 'common';
};

const rarityToTier = {
  'legendary': 'S',
  'rare': 'A',
  'uncommon': 'B',
  'common': 'C'
};

const calculateTier = (avatar) => {
  if (!avatar.model) return 'U';
  const rarity = getModelRarity(avatar.model);
  return rarityToTier[rarity] || 'U';
};

// Add escapeRegExp function to sanitize avatar names for regex
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escapes special characters
}

// API Routes
app.get('/api/leaderboard', async (req, res) => {
  const limit = parseInt(req.query.limit) || 24;
  const lastMessageCount = parseInt(req.query.lastMessageCount);
  const lastId = req.query.lastId;
  const tierFilter = req.query.tier;

  try {
    // Use the established db connection
    // Ensure 'db' is initialized
    if (!db) {
      throw new Error('Database not connected');
    }

    // Get total count of unique users first
    const totalCountResult = await db.collection('messages').aggregate([
      {
        $group: {
          _id: '$authorUsername',
        }
      },
      {
        $count: 'total'
      }
    ]).toArray();

    const totalCount = totalCountResult[0]?.total || 0;

    // Main aggregation pipeline
    const pipeline = [
      {
        $group: {
          _id: '$authorUsername',
          messageCount: { $sum: 1 },
          originalName: { $first: '$authorUsername' },
          lastMessage: { $max: '$timestamp' },
          recentMessages: {
            $push: {
              content: '$content',
              timestamp: '$timestamp'
            }
          }
        }
      },
      // Always lookup avatars
      {
        $lookup: {
          from: 'avatars',
          let: { name: '$originalName' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [
                    { $strcasecmp: ['$name', '$$name'] }, 0
                  ]
                }
              }
            },
            { $limit: 1 }
          ],
          as: 'avatarInfo'
        }
      },
      // Always unwind avatarInfo
      {
        $unwind: {
          path: '$avatarInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      // Add dungeon stats lookup
      {
        $lookup: {
          from: 'dungeon_stats',
          localField: 'avatarInfo._id',
          foreignField: 'avatarId',
          as: 'dungeonStats'
        }
      },
      {
        $unwind: {
          path: '$dungeonStats',
          preserveNullAndEmptyArrays: true
        }
      }
    ];

    // Add tier filtering if needed
    if (tierFilter) {
      if (tierFilter === 'U') {
        pipeline.push({
          $match: {
            $or: [
              { 'avatarInfo.model': { $exists: false } },
              { 'avatarInfo.model': null },
              {
                'avatarInfo.model': {
                  $nin: models.map(m => m.model)
                }
              }
            ]
          }
        });
      } else {
        pipeline.push({
          $match: {
            'avatarInfo.model': {
              $in: models
                .filter(m => rarityToTier[m.rarity] === tierFilter)
                .map(m => m.model)
            }
          }
        });
      }
    }

    // Add sorting and pagination
    pipeline.push({ $sort: { messageCount: -1, _id: 1 } });

    // Add cursor conditions if we have a last message
    if (lastMessageCount && lastId) {
      pipeline.push({
        $match: {
          $or: [
            { messageCount: { $lt: lastMessageCount } },
            {
              messageCount: lastMessageCount,
              _id: { $gt: lastId }
            }
          ]
        }
      });
    }

    // Add limit
    pipeline.push({ $limit: limit + 1 });

    const messageStats = await db.collection('messages')
      .aggregate(pipeline).toArray();

    const hasMore = messageStats.length > limit;
    const avatarsToReturn = messageStats.slice(0, limit);

    // Get avatar details for the paginated results
    const avatarDetailsArray = await Promise.all(avatarsToReturn.map(async (stat) => {
      const avatar = stat.avatarInfo;

      if (!avatar) return null;

      // Re-add fetching lastReflection with escaped name
      const escapedName = escapeRegExp(stat.originalName);
      const lastReflection = await db.collection('reflections').findOne(
        { name: { $regex: `^${escapedName}$`, $options: 'i' } }, // Case-insensitive exact match
        { 
          sort: { timestamp: -1 },
          projection: { reflectionContent: 1, timestamp: 1 }
        }
      );

      // Get dungeon stats
      const dungeonStats = stat.dungeonStats || { attack: 0, defense: 0, hp: 0 };

      return {
        ...avatar,
        messageCount: stat.messageCount,
        lastMessage: stat.lastMessage,
        recentMessages: stat.recentMessages.slice(0, 5),
        lastReflection: lastReflection?.reflectionContent || null,
        lastReflectionTime: lastReflection?.timestamp || null,
        tier: calculateTier(avatar),  // Changed to use model rarity
        lives: avatar.lives, // Include lives
        attack: dungeonStats.attack || 0,
        defense: dungeonStats.defense || 0,
        hp: dungeonStats.hp || 0
      };
    }));

    // Filter out null values and send response
    const validAvatars = avatarDetailsArray.filter(avatar => avatar !== null);
    
    res.json({
      avatars: validAvatars,
      hasMore,
      total: totalCount,
      lastMessageCount: validAvatars.length ? validAvatars[validAvatars.length - 1].messageCount : null,
      lastId: validAvatars.length ? validAvatars[validAvatars.length - 1]._id : null
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: error.message });
  }
  // Remove the finally block that closes the connection
});

app.get('/api/avatar/:id/reflections', async (req, res) => {
  try {
    // Use the established db connection
    if (!db) {
      throw new Error('Database not connected');
    }

    const avatarId = req.params.id;

    // Fetch reflections
    const reflections = await db.collection('reflections')
      .find({ avatarId })
      .sort({ timestamp: -1 })
      .limit(5)
      .toArray();

    // Fetch dungeon_stats
    const dungeonStats = await db.collection('dungeon_stats').findOne(
      { avatarId },
      { projection: { attack: 1, defense: 1, hp: 1 } }
    );

    res.json({
      reflections,
      dungeonStats: dungeonStats || { attack: 0, defense: 0, hp: 0 }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
  // Remove the finally block that closes the connection
});

// Restore the /api/dungeon/log endpoint
app.get('/api/dungeon/log', async (req, res) => {
  try {
    // Use the established db connection
    if (!db) {
      throw new Error('Database not connected');
    }

    const combatLog = await db.collection('dungeon_log')
      .find({})
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();

    // Enrich combat log with avatar details
    const enrichedLog = await Promise.all(combatLog.map(async (entry) => {
      // Escape the actor's name to prevent regex issues
      const escapedActor = escapeRegExp(entry.actor);
      const avatar = await db.collection('avatars').findOne(
        { name: { $regex: `^${escapedActor}$`, $options: 'i' } }, // Case-insensitive exact match
        { projection: { name: 1, lives: 1 } }
      );

      return {
        ...entry,
        avatarName: avatar ? avatar.name : entry.actor,
        avatarLives: avatar?.lives || 3, // Default to 3 lives if not found
        locationName: entry.target
      };
    }));

    res.json(enrichedLog);
  } catch (error) {
    console.error('Error fetching combat log:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle server shutdown to close MongoDB connection
process.on('SIGINT', async () => {
  try {
    await mongoClient.close();
    console.log('MongoDB connection closed');
    process.exit(0);
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
    process.exit(1);
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});