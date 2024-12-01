import { sendAsWebhook } from '../discordService.mjs';
import { MongoClient } from 'mongodb';

export class ConversationHandler {
  constructor(client, aiService, logger, avatarService, dungeonService) {
    this.client = client;
    this.aiService = aiService;
    this.logger = logger;
    this.channelCooldowns = new Map();
    this.COOLDOWN_TIME = 6 * 60 * 60 * 1000; // 6 hours
    this.SUMMARY_LIMIT = 5;
    this.IDLE_TIME = 60 * 60 * 1000; // 1 hour
    this.lastUpdate = Date.now();
    this.avatarService = avatarService;
    this.dungeonService = dungeonService;

    // Add response cooldown tracking
    this.responseCooldowns = new Map(); // avatarId -> channelId -> timestamp
    this.RESPONSE_COOLDOWN = 5 * 1000; // 5 seconds between responses in same channel

    // Add bot message handling
    this.botMessageQueue = new Map(); // channelId -> [{avatar, message, timestamp}]
    this.BOT_RESPONSE_INTERVAL = 30000; // Check every 30 seconds
    this.BOT_RESPONSE_CHANCE = 0.3; // 30% chance to respond to bot messages

    // Update cooldown times
    this.HUMAN_RESPONSE_COOLDOWN = 5000;  // 5 seconds for human messages
    this.BOT_RESPONSE_COOLDOWN = 300000;  // 5 minutes for bot messages
    this.INITIAL_RESPONSE_COOLDOWN = 10000; // 10 seconds after joining channel

    // Track last response times
    this.lastResponses = new Map(); // channelId -> Map<avatarId, {timestamp, wasBot}>
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

      if (!avatar.model) {
        avatar.model = await this.aiService.selectRandomModel();
        await this.avatarService.updateAvatar(avatar);
      }
      const prompt = this.buildNarrativePrompt(avatar, crossGuild, channelIds, lastNarrative);
      const narrative = await this.aiService.chat([
        { role: 'system', content: avatar.prompt || `You are ${avatar.name}. ${avatar.personality}` },
        { role: 'user', content: prompt }
      ], { model: avatar.model });

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

Describe your most recent dream, then based on the information above, describe any:
1. Significant moments and relationships.
2. Connections made mention special users or loacations.
3. Current thoughts, feelings, goals.`;
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
      const db = client.db(process.env.MONGO_DB_NAME);
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
      const db = client.db(process.env.MONGO_DB_NAME);
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
    const avatarId = avatar.id || avatar._id?.toString();
    const channelId = channel.id;

    try {

      // Get recent channel messages
      const messages = await channel.messages.fetch({ limit: 10 });
      const messageHistory = messages.reverse().map(msg => ({
        author: msg.author.username,
        content: msg.content,
        timestamp: msg.createdTimestamp
      }));

      // if the last message was from this avatar, skip
      if (messageHistory[messageHistory.length - 1].author === avatar.name) {
        return;
      }

      // Get avatar's recent reflection
      const lastNarrative = await this.getLastNarrative(avatarId);

      // Build context for response
      const context = {
        recentMessages: messageHistory,
        lastReflection: lastNarrative?.content || 'No previous reflection',
        channelName: channel.name,
        guildName: channel.guild.name
      };

      if (!avatar.model || typeof avatar.model !== 'string') {
        avatar.model = await this.aiService.selectRandomModel();
        await this.avatarService.updateAvatar(avatar);
      }

      // Generate response using AI service
      let response = await this.aiService.chat([
        {
          role: 'system',
          content: `You are ${avatar.name}. ${avatar.personality}
          Your last reflection: ${context.lastReflection}
          
          ${await this.buildSystemPrompt(avatar)}
          `
        },
        {
          role: 'user',
          content: `Channel: #${context.channelName} in ${context.guildName}\n\nRecent messages:\n${context.recentMessages.map(m => `${m.author}: ${m.content}`).join('\n')
            }\n\nYou are ${avatar.name}. Respond to the chat in character advancing your goals and keeping the chat interesting. Keep it SHORT. No more than three sentences.`
        }
      ], {
        max_tokens: 256,
        model: avatar.model
      });

      if (!response) {
        this.logger.error(`Empty response for ${avatar.name}`);
        return;
      }

      // if the response starts with the avatar name, remove it
      if (response.startsWith(avatar.name + ':')) {
        response = response.replace(avatar.name + ':', '').trim();
      }

      // Extract and process tool commands using dungeonService
      const { commands, cleanText, commandLines } = this.dungeonService.extractToolCommands(response);

      let sentMessage;
      let commandResults = [];

      // Process commands first if any
      if (commands.length > 0) {
        this.logger.info(`Processing ${commands.length} commands for ${avatar.name}`);
        // Execute each command and collect results
        commandResults = await Promise.all(
          commands.map(cmd =>
            this.dungeonService.processAction(
              { channel, author: { id: avatarId, username: avatar.name }, content: response },
              cmd.command,
              cmd.params
            )
          )
        );


        sentMessage = await sendAsWebhook(
          this.client,
          channel.id,
          commandResults.join('\n'),
          '🛠️ ' + avatar.name,
          avatar.imageUrl
        );

        // load the avatar again to get the updated state
        avatar = await this.avatarService.getAvatarById(avatarId);
      }

      // Send the main response if there's clean text
      if (!commands.length || cleanText.trim()) {

        sentMessage = await sendAsWebhook(
          this.client,
          avatar.channelId,
          commands.length ? cleanText : response,
          avatar.name,
          avatar.imageUrl
        );
      }

      // Send command results if any
      const validResults = commandResults.filter(r => r);
      if (validResults.length > 0) {
        sentMessage = await sendAsWebhook(
          this.client,
          channel.id,
          validResults.join('\n'),
          avatar.name,
          avatar.imageUrl
        );
      }

      // Update cooldown
      this.updateResponseCooldown(avatarId, channelId);

      // Update last response time and type
      this.updateLastResponse(channelId, avatarId, Date.now(), false);

      return response;

    } catch (error) {
      this.logger.error(`Error sending response for ${avatar.name}: ${error.message}`);
      throw error;
    }
  }

  getLastResponse(channelId, avatarId) {
    return this.lastResponses.get(channelId)?.get(avatarId);
  }

  updateLastResponse(channelId, avatarId, timestamp, wasBot) {
    if (!this.lastResponses.has(channelId)) {
      this.lastResponses.set(channelId, new Map());
    }
    this.lastResponses.get(channelId).set(avatarId, { timestamp, wasBot });
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

  async buildSystemPrompt(avatar) {
    const basePrompt = `You are ${avatar.name}. ${avatar.personality}`;
    const sentimentPrompt = `You have not deveveloped any sentiments yet.`;
    const dungeonPrompt = `
    Sentiments:
    
    ${sentimentPrompt}

    Available commands:
    ${this.dungeonService.getCommandsDescription()}
    
    You can use these commands on a new line anywhere within your message.
  
    Example:

    *remembers the forest*

    I remember the forest, the trees whispering secrets in the wind.

    !move to the forest
  `;

    // Add location awareness to the prompt
    const location = await this.dungeonService.getAvatarLocation(avatar.id);
    const locationPrompt = location ?
      `\n\nYou are currently in ${location.name}. ${location.description}` :
      '\n\nYou are wandering between locations.';

    const movementPrompt = `\nYou can move to new locations using the !move command.`;

    return basePrompt + locationPrompt + movementPrompt + dungeonPrompt;
  }
}
