export class AvatarTracker {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
    this.avatarThreadMap = new Map(); // Maps avatarId to threadId
    this.channelAvatars = new Map();
    this.avatarChannels = new Map(); // Track channels per avatar
    this.guildActivity = new Map(); // avatarId -> Map<guildId, timestamp>
    this.channelAttention = new Map(); // channelId -> Map<avatarId, {level: number, lastUpdate: number}>
    this.mentionMemory = new Map(); // channelId -> Map<avatarId, {lastMention: number, messagesSince: number, mentionedBy: string}>
    this.MAX_MENTION_MEMORY = 10; // Increased from 5 to 10 messages
    this.MENTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes timeout for mentions
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

    // Initialize channel attention map if it doesn't exist
    if (!this.channelAttention.has(channelId)) {
      this.channelAttention.set(channelId, new Map());
    }
    
    // Initialize attention for this avatar in this channel
    if (!this.channelAttention.get(channelId).has(avatarId)) {
      this.channelAttention.get(channelId).set(avatarId, {
        level: 0,
        lastUpdate: Date.now()
      });
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
    this.channelAttention.get(channelId)?.delete(avatarId);
  }

  getAvatarsInChannel(channelId) {
    return Array.from(this.channelAvatars.get(channelId) || []);
  }

  clearChannel(channelId) {
    this.channelAvatars.delete(channelId);
    this.channelAttention.delete(channelId);
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

  increaseAttention(channelId, avatarId, amount = 1) {
    if (!this.channelAttention.has(channelId)) {
      this.channelAttention.set(channelId, new Map());
    }
    
    const avatarAttention = this.channelAttention.get(channelId).get(avatarId) || {
      level: 0,
      lastUpdate: Date.now()
    };
    
    avatarAttention.level += amount;
    avatarAttention.lastUpdate = Date.now();
    
    this.channelAttention.get(channelId).set(avatarId, avatarAttention);
    this.logger.info(`${avatarId} attention in ${channelId} increased to ${avatarAttention.level}`);
  }

  getAttention(channelId, avatarId) {
    const channelMap = this.channelAttention.get(channelId);
    if (!channelMap) {
      return { level: 0, lastUpdate: 0 };
    }
    return channelMap.get(avatarId) || { level: 0, lastUpdate: 0 };
  }

  decayAttention(channelId, avatarId, decayAmount = 0.1) {
    const avatarAttention = this.getAttention(channelId, avatarId);
    const now = Date.now();
    const timeDiff = now - avatarAttention.lastUpdate;
    const decayFactor = Math.floor(timeDiff / (5 * 60 * 1000)); // Decay every 5 minutes
    
    if (decayFactor > 0) {
      avatarAttention.level = Math.max(0, avatarAttention.level - (decayAmount * decayFactor));
      avatarAttention.lastUpdate = now;
      
      this.channelAttention.get(channelId)?.set(avatarId, avatarAttention);
    }
    
    return avatarAttention.level;
  }

  isRecentlyMentioned(channelId, avatarId) {
    const mentionData = this.mentionMemory.get(channelId)?.get(avatarId);
    if (!mentionData) return false;

    const timeSinceMention = Date.now() - mentionData.lastMention;
    return timeSinceMention < this.MENTION_TIMEOUT && 
           mentionData.messagesSince < this.MAX_MENTION_MEMORY;
  }

  shouldAutoRespond(channelId, avatarId, currentAuthorId) {
    // Check for recent mentions first
    if (this.isRecentlyMentioned(channelId, avatarId)) {
      const mentionData = this.mentionMemory.get(channelId)?.get(avatarId);
      // Only auto-respond if the current message is from the user who mentioned the avatar
      if (mentionData?.mentionedBy === currentAuthorId) {
        return Math.random() < 0.4; // 40% chance to respond to mentioning user
      }
    }
    return false;
  }

  handleMention(channelId, avatarId, mentionedBy) {
    if (!this.mentionMemory.has(channelId)) {
      this.mentionMemory.set(channelId, new Map());
    }

    this.mentionMemory.get(channelId).set(avatarId, {
      lastMention: Date.now(),
      messagesSince: 0,
      responsesSent: 0,
      mentionedBy: mentionedBy // Store the user ID who mentioned the avatar
    });

    // Set high attention level
    this.increaseAttention(channelId, avatarId, 1.0);
  }

  trackChannelMessage(channelId, authorId) {
    const channelMentions = this.mentionMemory.get(channelId);
    if (!channelMentions) return;

    for (const [avatarId, data] of channelMentions) {
      // Only increment message count if it's from the user who mentioned the avatar
      if (data.mentionedBy === authorId) {
        data.messagesSince++;
      }
      
      // Only remove from memory if exceeded timeout or max messages from mentioning user
      const timeSinceMention = Date.now() - data.lastMention;
      if ((data.messagesSince >= this.MAX_MENTION_MEMORY && 
           data.mentionedBy === authorId) || 
          timeSinceMention > this.MENTION_TIMEOUT) {
        channelMentions.delete(avatarId);
      }
    }
  }
}
