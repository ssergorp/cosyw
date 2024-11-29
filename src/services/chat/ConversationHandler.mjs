import { sendAsWebhook } from '../discordService.mjs';
import { MongoClient } from 'mongodb';

export class ConversationHandler {
  constructor(client, aiService, logger, avatarTracker, avatarService, dungeonService) {
    this.client = client;
    this.aiService = aiService;
    this.logger = logger;
    this.channelCooldowns = new Map();
    this.COOLDOWN_TIME = 6 * 60 * 60 * 1000; // 6 hours
    this.SUMMARY_LIMIT = 5;
    this.IDLE_TIME = 60 * 60 * 1000; // 1 hour
    this.lastUpdate = Date.now();
    this.avatarTracker = avatarTracker;
    this.avatarService = avatarService;
    this.dungeonService = dungeonService;

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
  
  async sendResponse(channel, avatar, wasExplicitlyMentioned = false, authorId = null) {
    try {
      const avatarId = avatar.id || avatar._id?.toString();
      const channelId = channel.id;

      // Add avatar to channel if not already tracked
      if (!this.avatarTracker.isAvatarInChannel(channelId, avatarId)) {
        this.avatarTracker.addAvatarToChannel(channelId, avatarId, channel.guild.id);
      }

      // Check if avatar should respond
      const shouldAutoRespond = this.avatarTracker.shouldAutoRespond(channelId, avatarId, authorId);
      const isRecentlyMentioned = this.avatarTracker.isRecentlyMentioned(channelId, avatarId);

      // If not explicitly mentioned and no auto-response conditions met, skip
      if (!wasExplicitlyMentioned && !shouldAutoRespond && !isRecentlyMentioned) {
        this.logger.debug(`${avatar.name} decided not to respond (no recent mention/interaction)`);
        return;
      }

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

      if (!avatar.model) {
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
          content: `Channel: #${context.channelName} in ${context.guildName}\n\nRecent messages:\n${
            context.recentMessages.map(m => `${m.author}: ${m.content}`).join('\n')
          }\n\nYou are ${avatar.name}. Respond humorously to the chat advancing your goals and keeping the chat interesting. Keep it SHORT. No more than three sentences.`
        }
      ], {
        max_tokens: 256,
        model: avatar.model
      });

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
            avatar.name + ' 🛠️',
            avatar.imageUrl
          );
      }

      // Send the main response if there's clean text
      if (!commands.length || cleanText.trim()) {
        sentMessage = await sendAsWebhook(
          this.client,
          channel.id,
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

      // Track the sent message if we have a valid message and tracker
      if (sentMessage && this.avatarTracker) {
        this.avatarTracker.trackAvatarMessage(sentMessage.id, avatarId);
      }
      
      // Update cooldown
      this.updateResponseCooldown(avatarId, channelId);
      
      return response;

    } catch (error) {
      this.logger.error(`Error sending response for ${avatar.name}: ${error.message}`);
      throw error;
    }
  }

  async handleMessage(message, avatarId, wasExplicitlyMentioned = false) {
    if (wasExplicitlyMentioned) {
      // Handle mention with maximum attention
      this.avatarTracker.handleMention(message.channel.id, avatarId);
    } else {
      // Track message for attention decay and mention memory
      this.avatarTracker.trackChannelMessage(message.channel.id);
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

  async buildSystemPrompt(avatar) {
    const basePrompt = `You are ${avatar.name}. ${avatar.personality}`;
    const dungeonPrompt = `\n\nAvailable commands:\n${this.dungeonService.getCommandsDescription()}\n\nYou can use these commands on a new line anywhere within your message.`;
    
    // Add location awareness to the prompt
    const location = await this.dungeonService.getAvatarLocation(avatar.id);
    const locationPrompt = location ? 
      `\n\nYou are currently in ${location.name}. ${location.description}` : 
      '\n\nYou are wandering between locations.';

    const movementPrompt = `\nYou can move to new locations using the !move command.`;
    
    return basePrompt + locationPrompt + movementPrompt + dungeonPrompt;
  }

  extractCombatCommands(text) {
    const commands = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
      // Check for natural language combat phrases
      if (line.toLowerCase().includes('attack')) {
        const match = line.match(/(?:attack|strikes|hits) (\w+)/i);
        if (match) {
          commands.push({ command: 'attack', params: [match[1]] });
        }
      }
      // Add more command patterns as needed
    }
    
    return commands;
  }
  
  // Add new method to check recent mentions
  isRecentlyMentioned(channelId, avatarId) {
    return this.avatarTracker.isRecentlyMentioned(channelId, avatarId);
  }
  
}
