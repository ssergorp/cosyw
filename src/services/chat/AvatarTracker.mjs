export class AvatarTracker {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
    this.avatarThreadMap = new Map(); // Maps avatarId to threadId
    this.channelAvatars = new Map();
    this.avatarChannels = new Map(); // Track channels per avatar
    this.guildActivity = new Map(); // avatarId -> Map<guildId, timestamp>
  }

  MAX_CHANNELS_PER_AVATAR = 3;

  addAvatarToChannel(channelId, avatarId, guildId) {
    if (!avatarId) {
      this.logger.error('Attempted to add avatar without an ID to channel:', channelId);
      return;
    }

    if (!guildId) { // Added validation
      throw new Error('guildId is required to add an avatar to a channel.');
    }

    // Track guild activity
    if (!this.guildActivity.has(avatarId)) {
      this.guildActivity.set(avatarId, new Map());
    }
    this.guildActivity.get(avatarId).set(guildId, Date.now());

    // Initialize avatar's channel set if needed
    if (!this.avatarChannels.has(avatarId)) {
      this.avatarChannels.set(avatarId, new Set());
    }

    // Check channel limit
    if (this.avatarChannels.get(avatarId).size >= this.MAX_CHANNELS_PER_AVATAR) {
      return false;
    }

    // Add to both tracking maps
    this.avatarChannels.get(avatarId).add(channelId);
    if (!this.channelAvatars.has(channelId)) {
      this.channelAvatars.set(channelId, new Set());
    }
    this.channelAvatars.get(channelId).add(avatarId);
    this.logger.info(`Avatar ${avatarId} added to channel ${channelId} in guild ${guildId}`);
    
    return true;
  }

  removeAvatarFromChannel(channelId, avatarId) {
    if (this.channelAvatars.has(channelId)) {
      this.channelAvatars.get(channelId).delete(avatarId);
    }
  }

  getAvatarsInChannel(channelId) {
    return Array.from(this.channelAvatars.get(channelId) || []);
  }

  clearChannel(channelId) {
    this.channelAvatars.delete(channelId);
  }

  isAvatarInChannel(channelId, avatarId) {
    return this.channelAvatars.has(channelId) && 
           this.channelAvatars.get(channelId).has(avatarId);
  }

  getAvatarChannels(avatarId) {
    return Array.from(this.avatarChannels.get(avatarId) || []);
  }

  canJoinChannel(avatarId) {
    const channels = this.avatarChannels.get(avatarId);
    return !channels || channels.size < this.MAX_CHANNELS_PER_AVATAR;
  }

  getActiveGuilds(avatarId) {
    return Array.from(this.guildActivity.get(avatarId)?.keys() || []);
  }

  getMostActiveGuild(avatarId) {
    const guildMap = this.guildActivity.get(avatarId);
    if (!guildMap) return null;

    let mostRecentGuildId = null;
    let mostRecentTime = 0;

    for (const [guildId, timestamp] of guildMap) {
      if (timestamp > mostRecentTime) {
        mostRecentTime = timestamp;
        mostRecentGuildId = guildId;
      }
    }

    return mostRecentGuildId;
  }

  // Find or create a thread for the given avatar
  async getOrCreateAvatarThread(avatar) {
    const avatarId = avatar.id || avatar._id?.toString();
    if (this.avatarThreadMap.has(avatarId)) {
      return this.client.channels.cache.get(this.avatarThreadMap.get(avatarId));
    }

    // Search for the thread in the 'avatars' channel
    const guild = this.client.guilds.cache.first();
    if (!guild) {
      this.logger.error('Guild not found in AvatarTracker');
      return null;
    }

    const avatarsChannel = guild.channels.cache.find(c => c.name === 'avatars' && c.isTextBased());
    if (!avatarsChannel) {
      this.logger.error('Avatars channel not found');
      return null;
    }

    // Search for existing thread
    const existingThread = avatarsChannel.threads.cache.find(t => t.name === `${avatar.name} ${avatar.emoji}`);
    if (existingThread) {
      this.avatarThreadMap.set(avatarId, existingThread.id);
      return existingThread;
    }

    // Create a new thread if it doesn't exist
    try {
      const thread = await avatarsChannel.threads.create({
        name: `${avatar.name} ${avatar.emoji}`,
        autoArchiveDuration: 1440, // 24 hours
        reason: `Thread for avatar ${avatar.name}`
      });
      this.avatarThreadMap.set(avatarId, thread.id);
      this.logger.info(`Created new thread for avatar ${avatar.name}`);
      return thread;
    } catch (error) {
      this.logger.error(`Error creating thread for avatar ${avatar.name}: ${error.message}`);
      return null;
    }
  }
}
