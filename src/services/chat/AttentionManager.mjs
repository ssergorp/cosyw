export class AttentionManager {
  constructor(logger) {
    this.logger = logger;
    this.attentionLevels = new Map(); // key: `${channelId}-${avatarId}`, value: number 0-1
    this.ATTENTION_DECAY = 0.1; // Decay rate per check
    this.ATTENTION_CHECK_INTERVAL = 60000; // 1 minute
    this.POST_MENTION_MESSAGES = 3; // Number of messages to track after mention
    this.messageCounter = new Map(); // key: `${channelId}-${avatarId}`, value: messages since mention
    
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
    const currentLevel = this.getAttention(channelId, avatarId);
    this.setAttention(channelId, avatarId, currentLevel + amount);
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
    // Recently mentioned avatars have higher chance to respond
    if (this.isRecentlyMentioned(channelId, avatarId)) {
      return Math.random() < 0.8; // 80% chance to respond after mention
    }

    // Normal attention-based logic
    return this.shouldForceRespond(channelId, avatarId) ||
           this.shouldRandomlyRespond(channelId, avatarId) ||
           this.shouldConsiderResponse(channelId, avatarId);
  }
}