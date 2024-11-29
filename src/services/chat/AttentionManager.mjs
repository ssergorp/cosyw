export class AttentionManager {
  constructor(logger) {
    this.logger = logger;
    this.attentionLevels = new Map(); // key: channelId -> Map<avatarId, number>
    this.ATTENTION_DECAY = 0.1; // Decay rate per check
    this.ATTENTION_CHECK_INTERVAL = 60000; // 1 minute
    this.POST_MENTION_MESSAGES = 3; // Number of messages to track after mention
    this.messageCounter = new Map(); // key: `${channelId}-${avatarId}`, value: messages since mention
    this.attentionThreshold = 0.4; // Threshold for deciding to respond
    this.decayRate = 0.1; // Rate at which attention decays
    this.channelAttention = new Map();
    this.avatarMessages = new Map(); // messageId -> avatarId
    this.messageExpiry = 24 * 60 * 60 * 1000; // 24 hours
    this.BOT_COOLDOWN = 60000; // 1 minute cooldown for bot-to-bot interactions
    this.lastBotInteractions = new Map(); // tracks last bot interaction time per channel
    this.CHANNEL_COOLDOWN = 5000; // 5 second cooldown between any responses in same channel
    this.MAX_RESPONSES_PER_MINUTE = 4; // Max responses per minute in a channel
    this.lastChannelResponses = new Map(); // tracks last response time per channel
    this.responseCounters = new Map(); // tracks number of responses in last minute per channel
    
    // Human interaction settings
    this.HUMAN_MSG_INTERVAL = 3; // Respond every ~3 messages when humans are active
    this.humanMessageCounters = new Map(); // Tracks messages since last response per channel
    this.lastHumanInteraction = new Map(); // Tracks last human message timestamp
    this.HUMAN_ACTIVITY_TIMEOUT = 300000; // 5 minutes before channel considered inactive

    // Simplified attention constants
    this.ATTENTION_THRESHOLD = 0.4;
    this.MENTION_ATTENTION = 1.0;
    this.BASE_DECAY = 0.1;
    this.BOT_MESSAGE_TIMEOUT = 60000; // 1 minute cooldown after bot messages
    this.RECENT_MESSAGE_CHECK = 5; // Check last 5 messages for bot activity

    // Start decay interval
    setInterval(() => this.decayAttention(), this.ATTENTION_CHECK_INTERVAL);
  }

  setAttention(channelId, avatarId, level) {
    const key = `${channelId}-${avatarId}`;
    this.attentionLevels.set(key, Math.max(0, Math.min(1, level)));
  }

  getAttention(channelId, avatarId) {
    const key = `${channelId}-${avatarId}`;
    return this.attentionLevels.get(key) || 0;
  }

  increaseAttention(channelId, avatarId, amount = 0.2) {
    const key = `${channelId}-${avatarId}`;
    const currentAttention = this.attentionLevels.get(key) || 0;
    this.attentionLevels.set(key, Math.min(1, currentAttention + amount));
    
    this.logger.debug(`Attention for ${avatarId} in ${channelId} increased to ${this.attentionLevels.get(key)}`);
  }

  handleMention(channelId, avatarId) {
    const key = `${channelId}-${avatarId}`;
    this.attentionLevels.set(key, 1.0); // Set to maximum attention
    
    // Track post-mention messages
    if (!this.messageCounter.has(key)) {
      this.messageCounter.set(key, this.POST_MENTION_MESSAGES);
    }
  }

  trackMessage(channelId) {
    if (!this.attentionLevels.has(channelId)) {
      this.attentionLevels.set(channelId, new Map());
    }

    // Decrease message counters for all avatars in this channel
    for (const [key, count] of this.messageCounter.entries()) {
      if (key.startsWith(`${channelId}-`)) {
        const newCount = count - 1;
        if (newCount <= 0) {
          this.messageCounter.delete(key);
        } else {
          this.messageCounter.set(key, newCount);
        }
      }
    }
  }

  isRecentlyMentioned(channelId, avatarId) {
    return this.messageCounter.has(`${channelId}-${avatarId}`);
  }

  trackAvatarMessage(messageId, avatarId) {
    this.avatarMessages.set(messageId, {
      avatarId,
      timestamp: Date.now()
    });
  }

  getMessageAuthorAvatar(messageId) {
    const entry = this.avatarMessages.get(messageId);
    if (!entry) return null;
    
    // Check if message is expired
    if (Date.now() - entry.timestamp > this.messageExpiry) {
      this.avatarMessages.delete(messageId);
      return null;
    }
    
    return entry.avatarId;
  }

  cleanupExpiredMessages() {
    const now = Date.now();
    for (const [messageId, entry] of this.avatarMessages.entries()) {
      if (now - entry.timestamp > this.messageExpiry) {
        this.avatarMessages.delete(messageId);
      }
    }
  }

  decayAttention() {
    for (const [key, level] of this.attentionLevels.entries()) {
      const newLevel = Math.max(0, level - this.ATTENTION_DECAY);
      if (newLevel === 0) {
        this.attentionLevels.delete(key);
        this.messageCounter.delete(key); // Added cleanup for messageCounter
      } else {
        this.attentionLevels.set(key, newLevel);
      }
    }
    this.cleanupExpiredMessages(); // Add cleanup to decay cycle
    
    // Clean up expired human interaction tracking
    const now = Date.now();
    for (const [channelId, lastTime] of this.lastHumanInteraction.entries()) {
      if (now - lastTime > this.HUMAN_ACTIVITY_TIMEOUT) {
        this.lastHumanInteraction.delete(channelId);
        this.humanMessageCounters.delete(channelId);
      }
    }
  }

  shouldForceRespond(channelId, avatarId) {
    const attention = this.getAttention(channelId, avatarId);
    return attention >= 1;
  }

  shouldConsiderResponse(channelId, avatarId) {
    const attention = this.getAttention(channelId, avatarId);
    return attention >= 0.3 && attention <= 0.7;
  }

  shouldRandomlyRespond(channelId, avatarId) {
    const attention = this.getAttention(channelId, avatarId);
    return attention > 0 && attention < 0.3 && Math.random() < attention;
  }

  shouldRespond(channelId, avatarId, isResponseToBot = false, isFromHuman = false) {
    // Rate limit check
    if (!this.canRespondInChannel(channelId)) {
      return false;
    }

    // Get current attention
    const attention = this.getAttention(channelId, avatarId);

    // Force response on high attention
    if (attention >= this.MENTION_ATTENTION) {
      return true;
    }

    // Bot interaction handling
    if (!isFromHuman) {
      if (!this.canRespondToBot(channelId)) {
        this.logger.info(`Bot cooldown active in channel ${channelId}`);
        return false;
      }
      
      // Lower chance of response for bot interactions
      return Math.random() < (attention * 0.3);
    }

    // Human interaction
    const messageCount = this.humanMessageCounters.get(channelId) || 0;
    const lastHumanTime = this.lastHumanInteraction.get(channelId) || 0;
    const now = Date.now();

    // Update human activity
    this.lastHumanInteraction.set(channelId, now);
    this.humanMessageCounters.set(channelId, messageCount + 1);

    // Reset if channel inactive
    if (now - lastHumanTime > this.HUMAN_ACTIVITY_TIMEOUT) {
      this.humanMessageCounters.set(channelId, 0);
      return false;
    }

    // Regular attention-based response chance
    return Math.random() < attention;
  }

  canRespondToBot(channelId) {
    const lastInteraction = this.lastBotInteractions.get(channelId) || 0;
    const now = Date.now();
    const elapsed = now - lastInteraction;
    
    if (elapsed < this.BOT_COOLDOWN) {
      return false;
    }
    
    this.lastBotInteractions.set(channelId, now);
    return true;
  }

  canRespondInChannel(channelId) {
    const now = Date.now();
    
    // Check channel cooldown
    const lastResponse = this.lastChannelResponses.get(channelId) || 0;
    if (now - lastResponse < this.CHANNEL_COOLDOWN) {
      this.logger.info(`Response cooldown active for channel ${channelId}`);
      return false;
    }

    // Check rate limit
    const counter = this.responseCounters.get(channelId) || 0;
    if (counter >= this.MAX_RESPONSES_PER_MINUTE) {
      this.logger.info(`Rate limit reached for channel ${channelId}`);
      return false;
    }

    // Update trackers
    this.lastChannelResponses.set(channelId, now);
    this.responseCounters.set(channelId, counter + 1);

    // Reset counter after 1 minute
    setTimeout(() => {
      const currentCount = this.responseCounters.get(channelId) || 0;
      this.responseCounters.set(channelId, Math.max(0, currentCount - 1));
    }, 60000);

    return true;
  }

  increaseChannelAttention(channelId) {
    const currentAttention = this.channelAttention.get(channelId) || 0;
    this.channelAttention.set(channelId, currentAttention + 1);
    return currentAttention + 1;
  }

  decreaseChannelAttention(channelId) {
    const currentAttention = this.channelAttention.get(channelId) || 0;
    if (currentAttention > 0) {
      this.channelAttention.set(channelId, currentAttention - 1);
    }
    return Math.max(0, currentAttention - 1);
  }

  getChannelAttention(channelId) {
    return this.channelAttention.get(channelId) || 0;
  }

  resetChannelAttention(channelId) {
    this.channelAttention.set(channelId, 0);
  }

  async checkRecentBotActivity(channel) {
    try {
      const messages = await channel.messages.fetch({ limit: this.RECENT_MESSAGE_CHECK });
      const lastMessage = messages.first();
      
      if (!lastMessage) return false;

      // Check if most recent message is from a bot
      if (lastMessage.author.bot) {
        const timeSinceBot = Date.now() - lastMessage.createdTimestamp;
        return timeSinceBot < this.BOT_MESSAGE_TIMEOUT;
      }

      return false;
    } catch (error) {
      this.logger.error(`Error checking recent bot activity: ${error.message}`);
      return false;
    }
  }
}