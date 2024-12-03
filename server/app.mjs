import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb'; // Added ObjectId for ID handling
import models from '../src/models.config.mjs';
import avatarRoutes from './routes/avatars.mjs';
import tribeRoutes from './routes/tribes.mjs';

const app = express();
const port = process.env.PORT || 3080;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const mongoClient = new MongoClient(process.env.MONGO_URI);

// Connect to MongoDB once during server startup
let db;
await (async () => {
  try {
    await mongoClient.connect();
    db = mongoClient.db('cosyworld2');
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1); // Exit process with failure
  }
})().catch(error => {
  console.error('MongoDB connection error:', error);
  process.exit(1); // Exit process with failure
});

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
app.use('/api/avatars', avatarRoutes(db));
app.use('/api/tribes', tribeRoutes(db));

app.get('/api/leaderboard', async (req, res) => {
  const limit = parseInt(req.query.limit) || 24;
  const lastMessageCount = parseInt(req.query.lastMessageCount);
  const lastId = req.query.lastId;
  const tierFilter = req.query.tier;

  try {
    if (!db) {
      throw new Error('Database not connected');
    }

    // Get total count of unique users first (case insensitive)
    const totalCountResult = await db.collection('messages').aggregate([
      {
        $group: {
          _id: { $toLower: '$authorUsername' }
        }
      },
      {
        $count: 'total'
      }
    ]).toArray();

    const totalCount = totalCountResult[0]?.total || 0;

    // Main aggregation pipeline with case-insensitive grouping
    const pipeline = [
      {
        $group: {
          _id: { $toLower: '$authorUsername' }, // Group by lowercase name
          messageCount: { $sum: 1 },
          originalNames: { $addToSet: '$authorUsername' }, // Keep track of all case variations
          lastMessage: { $max: '$timestamp' },
          recentMessages: {
            $push: {
              $cond: {
                if: { $gte: ["$timestamp", { $subtract: [new Date(), 1000 * 60 * 60 * 24] }] },
                then: {
                  content: { $substr: ["$content", 0, 200] },
                  timestamp: "$timestamp"
                },
                else: null
              }
            }
          }
        }
      },
      // Project stage remains similar but include originalNames
      {
        $project: {
          messageCount: 1,
          lastMessage: 1,
          originalNames: 1, // Keep the original names array
          recentMessages: {
            $slice: [
              {
                $filter: {
                  input: "$recentMessages",
                  as: "msg",
                  cond: { $ne: ["$$msg", null] }
                }
              },
              5
            ]
          }
        }
      },
      // Modified avatar lookup to use case-insensitive match
      {
        $lookup: {
          from: 'avatars',
          let: { normalized_name: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [{ $toLower: '$name' }, '$$normalized_name']
                }
              }
            },
            {
              $project: {
                _id: 1,
                name: 1,
                emoji: 1,
                model: 1,
                lives: 1,
                imageUrl: 1,
                description: { $substr: ['$description', 0, 500] },
                dynamicPersonality: { $substr: ['$dynamicPersonality', 0, 500] },
                status: 1,
                createdAt: 1
              }
            }
          ],
          as: 'avatarInfo'
        }
      },
      // Add dungeon stats with limited fields
      {
        $lookup: {
          from: 'dungeon_stats',
          localField: 'avatarInfo._id',
          foreignField: 'avatarId',
          pipeline: [
            {
              $project: {
                attack: 1,
                defense: 1,
                hp: 1
              }
            }
          ],
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

    // Update cursor conditions for more precise pagination
    if (lastMessageCount && lastId) {
      pipeline.push({
        $match: {
          $or: [
            { messageCount: { $lt: lastMessageCount } },
            {
              $and: [
                { messageCount: lastMessageCount },
                { _id: { $gt: lastId } }
              ]
            }
          ]
        }
      });
    }

    // Add sorting first, then limit
    pipeline.push(
      { 
        $sort: { 
          messageCount: -1, 
          _id: 1  // Ensure consistent ordering for same message counts
        }
      },
      { 
        $limit: limit + 1 
      }
    );

    const messageStats = await db.collection('messages')
      .aggregate(pipeline, { 
        allowDiskUse: true // Add this option for large datasets
      }).toArray();

    const hasMore = messageStats.length > limit;
    const avatarsToReturn = messageStats.slice(0, limit);

    // Get avatar details for the paginated results
    const avatarDetailsArray = await Promise.all(avatarsToReturn.map(async (stat) => {
      const avatar = stat.avatarInfo[0]; // Take first matching avatar
      if (!avatar) return null;

      // Use the normalized name for reflections lookup
      const normalizedName = stat._id;
      const lastReflection = await db.collection('reflections').findOne(
        { name: { $regex: `^${normalizedName}$`, $options: 'i' } },
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
        hp: dungeonStats.hp || 0,
        originalNames: stat.originalNames // Include all name variations
      };
    }));

    // Filter out null values and send response
    const validAvatars = avatarDetailsArray.filter(avatar => avatar !== null);
    
    // Update the cursor values from the last item we're actually returning
    const lastItem = avatarsToReturn[avatarsToReturn.length - 1];

    res.json({
      avatars: validAvatars,
      hasMore,
      total: totalCount,
      lastMessageCount: lastItem ? lastItem.messageCount : null,
      lastId: lastItem ? lastItem._id : null
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

    // Fetch recent messages if needed
    const recentMessages = await db.collection('messages')
      .find({ authorId: avatarId })
      .sort({ timestamp: -1 })
      .limit(5)
      .toArray();

    res.json({
      reflections,
      dungeonStats: dungeonStats || { attack: 0, defense: 0, hp: 0 },
      recentMessages
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
  // Remove the finally block that closes the connection
});

// Modify the /api/dungeon/log endpoint to include imageUrl in combat log entries
app.get('/api/dungeon/log', async (req, res) => {
  try {
    if (!db) throw new Error('Database not connected');

    const combatLog = await db.collection('dungeon_log')
      .find({})
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();

    // Enrich combat log with avatar details including imageUrl
    const enrichedLog = await Promise.all(combatLog.map(async (entry) => {
      const escapedActor = escapeRegExp(entry.actor);
      const escapedTarget = entry.target ? escapeRegExp(entry.target) : null;
      
      const [actor, target] = await Promise.all([
        db.collection('avatars').findOne(
          { name: { $regex: `^${escapedActor}$`, $options: 'i' } },
          { projection: { name: 1, imageUrl: 1 } }
        ),
        escapedTarget ? db.collection('avatars').findOne(
          { name: { $regex: `^${escapedTarget}$`, $options: 'i' } },
          { projection: { name: 1, imageUrl: 1 } }
        ) : null
      ]);

      return {
        ...entry,
        avatarName: actor?.name || entry.actor,
        imageUrl: actor?.imageUrl || null,
        targetName: target?.name || entry.target,
        targetImageUrl: target?.imageUrl || null,
        locationName: entry.location || entry.target // fallback to target if location not specified
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