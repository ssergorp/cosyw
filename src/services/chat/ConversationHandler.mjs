import { sendAsWebhook } from '../discordService.mjs';
import { MongoClient } from 'mongodb';

export class ConversationHandler {
  constructor(client, aiService, logger, avatarTracker) {
    this.client = client;
    this.aiService = aiService;
    this.logger = logger;
    this.channelCooldowns = new Map();
    this.COOLDOWN_TIME = 6 * 60 * 60 * 1000; // 6 hours
    this.SUMMARY_LIMIT = 5;
    this.IDLE_TIME = 60 * 60 * 1000; // 1 hour
    this.lastUpdate = Date.now();
    this.avatarTracker = avatarTracker;

    // Add response cooldown tracking
    this.responseCooldowns = new Map(); // avatarId -> channelId -> timestamp
    this.RESPONSE_COOLDOWN = 5 * 1000; // 5 seconds between responses in same channel
  }

  async checkIdleUpdate(avatars) {
    if (Date.now() - this.lastUpdate >= this.IDLE_TIME) {
      const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];
      await this.generateNarrative(randomAvatar, { type: 'inner_monologue' });
      this.lastUpdate = Date.now();
    }
  }
  

  /**
   * Unified method to generate a narrative for reflection or inner monologue.
   */
  async generateNarrative(avatar, options = {}) {
    const { crossGuild = false, channelIds = [] } = options;

    try {
      const avatarId = avatar.id || avatar._id?.toString();
      if (!avatarId || typeof avatarId !== 'string') {
        throw new Error('Invalid avatar ID');
      }

      const lastNarrative = await this.getLastNarrative(avatarId);
      if (lastNarrative && Date.now() - lastNarrative.timestamp < this.COOLDOWN_TIME) {
        this.logger.info(`Narrative cooldown active for ${avatar.name}`);
        return;
      }

      const prompt = this.buildNarrativePrompt(avatar, crossGuild, channelIds, lastNarrative);
      const narrative = await this.aiService.chat([
        { role: 'system', content: `You are ${avatar.name}. ${avatar.personality}` },
        { role: 'user', content: prompt }
      ]);

      const thread = await this.getOrCreateThread(avatar);
      if (thread) {
        await sendAsWebhook(this.client, thread.id, narrative, avatar.name, avatar.imageUrl);
        await this.storeNarrative(thread, avatarId, narrative);
        this.updateNarrativeHistory(avatar, narrative, thread.guild.name);
      }

      return narrative;
    } catch (error) {
      this.logger.error(`Error generating narrative for ${avatar.name}: ${error.message}`);
      throw error;
    }
  }

  buildNarrativePrompt(avatar, crossGuild, channelIds, lastNarrative) {
    const basePrompt = `As ${avatar.name}, reflect deeply on your evolving story and interactions.`;

    if (crossGuild) {
      return `${basePrompt}

Based on interactions across communities, describe:
1. Patterns and themes noticed
2. Connections made
3. Current thoughts and feelings.`;
    }

    return `${basePrompt}

Previous Narrative:
${lastNarrative?.content || 'None yet.'}

Describe:
1. Your emotional state
2. Key memories and experiences
3. Goals and aspirations
4. Reflections on recent interactions.`;
  }

  async getOrCreateThread(avatar) {
    try {
      const guild = this.client.guilds.cache.first();
      if (!guild) throw new Error('No guilds available');

      const avatarChannel = guild.channels.cache.find(c => c.name === 'avatars');
      if (!avatarChannel) throw new Error('Avatars channel not found');

      const threadName = `${avatar.name} Narratives`;
      const existingThread = avatarChannel.threads.cache.find(t => t.name === threadName);

      if (existingThread) return existingThread;

      return await avatarChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440, // 24 hours
        reason: `Unified narrative thread for ${avatar.name}`
      });
    } catch (error) {
      this.logger.error(`Error creating thread for ${avatar.name}: ${error.message}`);
      throw error;
    }
  }

  async storeNarrative(thread, avatarId, content) {
    try {
      const client = new MongoClient(process.env.MONGO_URI);
      await client.connect();
      const db = client.db('discord');
      await db.collection('narratives').insertOne({
        threadId: thread.id,
        guildId: thread.guildId,
        channelId: thread.parentId,
        avatarId,
        content,
        timestamp: Date.now()
      });
      await client.close();
    } catch (error) {
      this.logger.error(`Error storing narrative for avatar ${avatarId}: ${error.message}`);
      throw error;
    }
  }

  async getLastNarrative(avatarId) {
    try {
      const client = new MongoClient(process.env.MONGO_URI);
      await client.connect();
      const db = client.db('discord');
      const lastNarrative = await db.collection('narratives')
        .findOne({ avatarId }, { sort: { timestamp: -1 } });
      await client.close();
      return lastNarrative;
    } catch (error) {
      this.logger.error(`Error fetching last narrative for avatar ${avatarId}: ${error.message}`);
      throw error;
    }
  }

  updateNarrativeHistory(avatar, content, guildName) {
    const narrativeData = { timestamp: Date.now(), content, guildName };
    avatar.narrativeHistory = avatar.narrativeHistory || [];
    avatar.narrativeHistory.unshift(narrativeData);
    avatar.narrativeHistory = avatar.narrativeHistory.slice(0, this.SUMMARY_LIMIT);

    avatar.narrativesSummary = avatar.narrativeHistory
      .map(r => `[${new Date(r.timestamp).toLocaleDateString()}] ${r.guildName}: ${r.content}`)
      .join('\n\n');
  }
  
  async sendResponse(channel, avatar) {
    try {
      const avatarId = avatar.id || avatar._id?.toString();
      const channelId = channel.id;

      // Check response cooldown
      const lastResponse = this.getLastResponseTime(avatarId, channelId);
      if (lastResponse && Date.now() - lastResponse < this.RESPONSE_COOLDOWN) {
        this.logger.info(`Response cooldown active for ${avatar.name} in channel ${channelId}`);
        return;
      }

      // Get recent channel messages
      const messages = await channel.messages.fetch({ limit: 10 });
      const messageHistory = messages.reverse().map(msg => ({
        author: msg.author.username,
        content: msg.content,
        timestamp: msg.createdTimestamp
      }));

      // Get avatar's recent reflection
      const lastNarrative = await this.getLastNarrative(avatarId);
      
      // Build context for response
      const context = {
        recentMessages: messageHistory,
        lastReflection: lastNarrative?.content || 'No previous reflection',
        channelName: channel.name,
        guildName: channel.guild.name
      };

      // Generate response using AI service
      const response = await this.aiService.chat([
        {
          role: 'system',
          content: `You are ${avatar.name}. ${avatar.personality}\n\nYour last reflection: ${context.lastReflection}`
        },
        {
          role: 'user',
          content: `Channel: #${context.channelName} in ${context.guildName}\n\nRecent messages:\n${
            context.recentMessages.map(m => `${m.author}: ${m.content}`).join('\n')
          }\n\nSend a message to the chat as ${avatar.name}, advancing your goals and keeping the chat interesting. Keep your responses in character and SHORT (no more than two or three sentences and *actions*).`
        }
      ]);

      // Send response through webhook
      await sendAsWebhook(this.client, channelId, response, avatar.name, avatar.imageUrl);
      
      // Update cooldown
      this.updateResponseCooldown(avatarId, channelId);
      
      return response;

    } catch (error) {
      this.logger.error(`Error sending response for ${avatar.name}: ${error.message}`);
      throw error;
    }
  }

  getLastResponseTime(avatarId, channelId) {
    return this.responseCooldowns.get(avatarId)?.get(channelId);
  }

  updateResponseCooldown(avatarId, channelId) {
    if (!this.responseCooldowns.has(avatarId)) {
      this.responseCooldowns.set(avatarId, new Map());
    }
    this.responseCooldowns.get(avatarId).set(channelId, Date.now());
  }
  
}
