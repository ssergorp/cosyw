export class AvatarTracker {
  constructor() {
    this.channelAvatars = new Map();
    this.avatarChannels = new Map(); // Track channels per avatar
    this.guildActivity = new Map(); // avatarId -> Map<guildId, timestamp>
    this.logger = console;
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
}
