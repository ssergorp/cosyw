export class AvatarTracker {
  constructor(client, logger, db) {
    this.client = client;
    this.logger = logger;
    this.db = db;
    
    // Simple caches with TTL
    this.avatarChannelCache = new Map(); // avatarId -> {channels: Set, expires: timestamp}
    this.channelAvatarCache = new Map(); // channelId -> {avatars: Set, expires: timestamp}
    
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.MAX_CHANNELS_PER_AVATAR = 3;

    this.summonedAvatars = new Map(); // channelId -> Set<avatarId>
    this.summonExpiry = new Map(); // channelId -> Map<avatarId, expiryTimestamp>
    this.SUMMON_DURATION = 30 * 60 * 1000; // 30 minutes
  }

  async getAvatarsInChannel(channelId) {
    try {
      const avatars = await this.db.collection('avatarChannels')
        .find({ channelId })
        .toArray();
      
      const avatarIds = avatars.map(a => a.avatarId);
      this.channelAvatarCache.set(channelId, {
        avatars: new Set(avatarIds),
        expires: Date.now() + this.CACHE_TTL
      });

      return avatarIds;
    } catch (error) {
      this.logger.error(`Failed to fetch avatars for channel ${channelId}:`, error);
      return [];
    }
  }

  async addAvatarToChannel(avatarId, channelId,  guildId) {
    try {
      const currentChannels = await this.getAvatarChannels(avatarId);
      if (currentChannels.length >= this.MAX_CHANNELS_PER_AVATAR) {
        return false;
      }

      await this.db.collection('avatarChannels').updateOne(
        { channelId, avatarId },
        { $set: { guildId, lastActive: new Date() } },
        { upsert: true }
      );

      // Update caches
      this.invalidateCache(channelId, avatarId);
      return true;
    } catch (error) {
      this.logger.error(`Failed to add avatar ${avatarId} to channel ${channelId}:`, error);
      return false;
    }
  }

  async removeAvatarFromChannel(channelId, avatarId) {
    try {
      await this.db.collection('avatarChannels').deleteOne({ channelId, avatarId });
      this.invalidateCache(channelId, avatarId);
    } catch (error) {
      this.logger.error(`Failed to remove avatar ${avatarId} from channel ${channelId}:`, error);
    }
  }

  async getAvatarChannels(avatarId) {
    const cached = this.avatarChannelCache.get(avatarId);
    if (cached && cached.expires > Date.now()) {
      return Array.from(cached.channels);
    }

    try {
      const channels = await this.db.collection('avatarChannels')
        .find({ avatarId })
        .toArray();
      
      const channelIds = channels.map(c => c.channelId);
      this.avatarChannelCache.set(avatarId, {
        channels: new Set(channelIds),
        expires: Date.now() + this.CACHE_TTL
      });

      return channelIds;
    } catch (error) {
      this.logger.error(`Failed to fetch channels for avatar ${avatarId}:`, error);
      return [];
    }
  }

  invalidateCache(channelId, avatarId) {
    this.channelAvatarCache.delete(channelId);
    this.avatarChannelCache.delete(avatarId);
  }

  async isAvatarInChannel(channelId, avatarId) {
    const avatars = await this.getAvatarsInChannel(channelId);
    return avatars.includes(avatarId);
  }

  async canJoinChannel(avatarId) {
    const channels = await this.getAvatarChannels(avatarId);
    return channels.length < this.MAX_CHANNELS_PER_AVATAR;
  }

  async summonAvatarToChannel(channelId, avatarId, guildId) {
    try {
      // Add to database first
      await this.addAvatarToChannel(avatarId, channelId, guildId);
      
      return true;
    } catch (error) {
      this.logger.error(`Failed to summon avatar ${avatarId} to channel ${channelId}:`, error);
      return false;
    }
  }

}
