import { MongoClient } from 'mongodb';

export class MemoryService {
  constructor(logger) {
    this.logger = logger;
  }

  async addMemory(avatarId, memory) {
    try {
      const client = new MongoClient(process.env.MONGO_URI);
      await client.connect();
      const db = client.db(process.env.MONGO_DB_NAME);
      
      await db.collection('memories').insertOne({
        avatarId,
        memory,
        timestamp: Date.now()
      });
      
      await client.close();
    } catch (error) {
      this.logger.error(`Error storing memory for avatar ${avatarId}: ${error.message}`);
      throw error;
    }
  }

  async getMemories(avatarId, limit = 10) {
    try {
      const client = new MongoClient(process.env.MONGO_URI);
      await client.connect();
      const db = client.db(process.env.MONGO_DB_NAME);
      
      const memories = await db.collection('memories')
        .find({ avatarId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      
      await client.close();
      return memories || [];
    } catch (error) {
      this.logger.error(`Error fetching memories for avatar ${avatarId}: ${error.message}`);
      throw error;
    }
  }
}
