
import { MongoClient } from 'mongodb';

export class AvatarManager {
  constructor(logger) {
    this.logger = logger;
  }

  async getAvatar(avatarId) {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db(process.env.MONGO_DB_NAME);
      return await db.collection('avatars').findOne({ _id: avatarId });
    } finally {
      await client.close();
    }
  }

  async updateAvatar(avatar) {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db(process.env.MONGO_DB_NAME);
      await db.collection('avatars').updateOne(
        { avatarId: avatar.avatarId },
        { $set: avatar },
        { upsert: true }
      );
    } finally {
      await client.close();
    }
  }

  async respawnAvatar(avatarId) {
    const avatar = await this.getAvatar(avatarId);
    if (!avatar) return;

    // Reset avatar stats
    avatar.status = 'alive';
    avatar.lives = 3;
    avatar.hp = 100;
    delete avatar.deathTimestamp;

    await this.updateAvatar(avatar);
    return avatar;
  }
}