import { sendAsWebhook } from '../discordService.mjs';

export class ConversationHandler {
  constructor(client, aiService, logger) {
    this.client = client;
    this.aiService = aiService;
    this.logger = logger;
    this.channelCooldowns = new Map();
    this.avatarReflectionHistory = new Map();
    this.CHANNEL_COOLDOWN = 5000;
    this.REFLECTION_COOLDOWN = 6 * 60 * 60 * 1000; // 6 hours
  }

  async reflectAvatar(avatar) {
    const avatarId = avatar.id || avatar._id?.toString();

    // Validate avatarId
    if (!avatarId || typeof avatarId !== 'string') {
      this.logger.error('Invalid avatarId in reflectAvatar:', avatar);
      return;
    }

    try {
      const reflectionContent = await this.generateReflectionContent(avatar);
      const thread = await this.createReflectionThread(avatar);

      if (thread && reflectionContent) {
        await sendAsWebhook(
          this.client,
          thread.id,
          `*Morning Reflection*
${reflectionContent}`,
          avatar.name,
          avatar.imageUrl
        );

        this.avatarReflectionHistory.set(avatarId, Date.now());
        this.logger.info(`Reflection completed for ${avatar.name} in thread ${thread.name}`);
      }

      return thread;
    } catch (error) {
      this.logger.error(`Error in avatar reflection: ${error.message}`);
      throw error;
    }
  }

  async generateReflectionContent(avatar) {
    try {
      return await this.aiService.chat([
        { role: 'system', content: `You are ${avatar.name}. ${avatar.personality}` },
        { role: 'user', content: 'Share a brief morning reflection on your current state of mind, goals, and feelings.' }
      ]);
    } catch (error) {
      this.logger.error(`Error generating reflection content for ${avatar.name}: ${error.message}`);
      throw error;
    }
  }

  async createReflectionThread(avatar) {
    try {
      const guild = this.client.guilds.cache.first();
      if (!guild) {
        throw new Error('No guilds available');
      }

      const avatarChannel = guild.channels.cache.find(c => c.name === 'avatars');

      if (!avatarChannel) {
        throw new Error('Avatars channel not found');
      }

      const randomHex = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0');
      const threadTitle = `${avatar.name} ${avatar.emoji} reflections 0x${randomHex}`;

      return await avatarChannel.threads.create({
        name: threadTitle,
        autoArchiveDuration: 1440,
        reason: 'Avatar Reflection Thread'
      });
    } catch (error) {
      this.logger.error(`Error creating reflection thread for ${avatar.name}: ${error.message}`);
      throw error;
    }
  }

  async triggerRandomReflection(avatars) {
    try {
      if (!avatars?.length) {
        this.logger.warn('No avatars available for reflection');
        return;
      }

      const eligibleAvatars = this.getEligibleAvatarsForReflection(avatars);
      if (!eligibleAvatars.length) {
        this.logger.info('No eligible avatars for reflection');
        return;
      }

      const randomAvatar = eligibleAvatars[Math.floor(Math.random() * eligibleAvatars.length)];
      return await this.reflectAvatar(randomAvatar);
    } catch (error) {
      this.logger.error(`Error in triggering random reflection: ${error.message}`);
      throw error;
    }
  }

  getEligibleAvatarsForReflection(avatars) {
    return avatars.filter(avatar => {
      const avatarId = avatar.id || avatar._id?.toString();
      const lastReflection = this.avatarReflectionHistory.get(avatarId) || 0;
      return Date.now() - lastReflection > this.REFLECTION_COOLDOWN;
    });
  }

  canRespond(channelId) {
    const lastResponse = this.channelCooldowns.get(channelId) || 0;
    return Date.now() - lastResponse >= this.CHANNEL_COOLDOWN;
  }

  async sendResponse(channel, avatar) {
    try {
      if (!channel?.id) {
        this.logger.error('Invalid channel object passed to sendResponse');
        return;
      }

      if (!this.canRespond(channel.id)) {
        this.logger.info(`Cooldown active for channel ${channel.id}, skipping response.`);
        return;
      }

      const context = await this.buildConversationContext(channel);
      if (!context.length) {
        this.logger.warn(`No valid messages found for context in channel ${channel.id}`);
        return;
      }

      const response = await this.generateAvatarResponse(avatar, context);

      if (response) {
        await sendAsWebhook(this.client, channel.id, response, avatar.name, avatar.imageUrl);
        this.channelCooldowns.set(channel.id, Date.now());
      }
    } catch (error) {
      this.logger.error(`Error sending response: ${error.message}`);
    }
  }

  async buildConversationContext(channel) {
    try {
      if (!channel?.messages?.fetch) {
        throw new Error('Channel does not support message fetching');
      }

      const messages = await channel.messages.fetch({ limit: 10 });
      return messages.reverse().map(m => ({
        role: m.author.bot ? 'assistant' : 'user',
        content: `${m.author.username}: ${m.content}`
      })).filter(m => m.content.trim() !== '');
    } catch (error) {
      this.logger.error(`Error fetching messages for context in channel ${channel?.id}: ${error.message}`);
      return [];
    }
  }

  async generateAvatarResponse(avatar, context) {
    try {
      return await this.aiService.chat([
        { role: 'system', content: `You are ${avatar.name}. \n\n${avatar.description}\n\n${avatar.dynamicPersonality}` },
        ...context,
        { role: 'user', content: `You are ${avatar.name}.\n\nRespond as ${avatar.name} to the conversation above, helping to move it forward, with one or two short sentences or actions. Do not include your own name in your response.` }
      ]);
    } catch (error) {
      this.logger.error(`Error generating response for ${avatar.name}: ${error.message}`);
      throw error;
    }
  }
}
