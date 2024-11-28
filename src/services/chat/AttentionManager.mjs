export class AttentionManager {
  constructor(logger) {
    this.logger = logger;
    this.attentionLevels = new Map(); // key: `${channelId}-${avatarId}`, value: number 0-1
    this.ATTENTION_DECAY = 0.1; // Decay rate per check
    this.ATTENTION_CHECK_INTERVAL = 60000; // 1 minute
    this.POST_MENTION_MESSAGES = 3; // Number of messages to track after mention
    this.messageCounter = new Map(); // key: `${channelId}-${avatarId}`, value: messages since mention
    this.attentionThreshold = 0.4; // Threshold for deciding to respond
    this.decayRate = 0.1; // Rate at which attention decays
    this.channelAttention = new Map();
    this.avatarMessages = new Map(); // messageId -> avatarId
    this.messageExpiry = 24 * 60 * 60 * 1000; // 24 hours
    
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
    if (!this.attentionLevels.has(channelId)) {
      this.attentionLevels.set(channelId, new Map());
    }
    const channelAttention = this.attentionLevels.get(channelId);
    if (!channelAttention) {
      this.logger.error('Channel attention map not found:', channelId);
      return;
    }
    const currentAttention = channelAttention.get(avatarId) || 0;
    channelAttention.set(avatarId, Math.min(1, currentAttention + amount));
  }

  handleMention(channelId, avatarId) {
    this.setAttention(channelId, avatarId, 1.0);
    this.messageCounter.set(`${channelId}-${avatarId}`, this.POST_MENTION_MESSAGES);
  }

  trackMessage(channelId) {
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

  shouldRespond(channelId, avatarId) {
    if (!this.attentionLevels.has(channelId)) {
      this.attentionLevels.set(channelId, new Map());
      this.attentionLevels.get(channelId).set(avatarId, 0.5);
    }
    const attention = this.attentionLevels.get(channelId)?.get(avatarId) || 0.5;
    const random = Math.random();
    return random < (attention + 0.1); // Small chance to respond even with low attention
  }
}