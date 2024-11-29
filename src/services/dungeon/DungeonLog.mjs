
import { MongoClient } from 'mongodb';

export class DungeonLog {
  constructor(logger) {
    this.logger = logger;
  }

  async logAction(action) {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db('discord');
      await db.collection('dungeon_log').insertOne({
        ...action,
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.error(`Error logging dungeon action: ${error.message}`);
    } finally {
      await client.close();
    }
  }

  async getRecentActions(channelId, limit = 5) {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db('discord');
      return await db.collection('dungeon_log')
        .find({ channelId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
    } finally {
      await client.close();
    }
  }
}