export class MessageProcessor {
  constructor(avatarService) {
    this.avatarService = avatarService;
    this.activeChannels = new Set();
    this.lastActivityTime = new Map();
    this.ACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    this.guildActivity = new Map(); // guildId -> lastActivity
  }

  async getActiveAvatars() {
    try {
      const avatars = await this.avatarService.getAllAvatars();
      if (!avatars?.length) {
        console.warn('No avatars found in database');
        return [];
      }
      
      const activeAvatars = avatars
        .filter(avatar => avatar && typeof avatar === 'object' && (avatar._id || avatar._id))
        .map(avatar => {
          const id = avatar._id || avatar._id;
          
          // Create normalized avatar object
          return {
            ...avatar,
            id,
            name: avatar.name || null,
            emoji: avatar.emoji || null,
            personality: avatar.personality || '',
            description: avatar.description || '',
            imageUrl: avatar.imageUrl || null,
            active: avatar.active !== false
          };
        })
        .filter(avatar => {
          if (!avatar._id || !avatar.name) {
            console.error('Invalid avatar data after normalization:', JSON.stringify(avatar, null, 2));
            return false;
          }
          return avatar.active;
        });

      return activeAvatars;
    } catch (error) {
      console.error('Error fetching active avatars:', error);
      return [];
    }
  }

  async getActiveChannels(client) {
    const now = Date.now();
    const channels = [];
    
    for (const [guildId, guild] of client.guilds.cache) {
      const lastActivity = this.guildActivity.get(guildId) || 0;
      if (now - lastActivity <= this.ACTIVITY_TIMEOUT) {
        const guildChannels = Array.from(guild.channels.cache.values())
          .filter(channel => this.activeChannels.has(channel.id) && channel.isTextBased()); // Added channel type check
        channels.push(...guildChannels);
      }
    }
    
    return channels;
  }

  markChannelActive(channelId, guildId) {
    this.activeChannels.add(channelId);
    this.lastActivityTime.set(channelId, Date.now());
    if (guildId) {
      this.guildActivity.set(guildId, Date.now());
    }
  }

  isChannelActive(channelId) {
    const lastActivity = this.lastActivityTime.get(channelId);
    return lastActivity && (Date.now() - lastActivity <= this.ACTIVITY_TIMEOUT);
  }
}
