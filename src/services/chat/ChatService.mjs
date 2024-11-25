import { AttentionManager } from './AttentionManager.mjs';
import { ConversationHandler } from './ConversationHandler.mjs';
import { DecisionMaker } from './DecisionMaker.mjs';
import { MessageProcessor } from './MessageProcessor.mjs';
import { AvatarTracker } from './AvatarTracker.mjs';
import { BackgroundConversationManager } from './BackgroundConversationManager.mjs'; // Added import
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async/fixed';

export class ChatService {
  constructor(client, mongoClient, { logger, avatarService, aiService }) {
    this.client = client;
    this.logger = logger;

    this.attentionManager = new AttentionManager(logger);
    this.conversationHandler = new ConversationHandler(client, aiService, logger);
    this.decisionMaker = new DecisionMaker(aiService, logger, this.attentionManager);
    this.messageProcessor = new MessageProcessor(avatarService);
    this.avatarTracker = new AvatarTracker();

    this.mongoClient = mongoClient;
    this.retryAttempts = 3;
    this.retryDelay = 5000; // 5 seconds
    this.isConnected = false;

    this.setupComplete = false;

    this.backgroundManager = new BackgroundConversationManager(logger);
    this.BACKGROUND_CHECK_INTERVAL = 5 * 60000; // Check every minute
    this.backgroundInterval = null;

    this.REFLECTION_INTERVAL = 3600000; // 1 hour
    this.REFLECTION_SUMMARY_LIMIT = 5; // Keep last 5 reflections
    this.AMBIENT_CHAT_INTERVAL = process.env.AMBIENT_CHAT_INTERVAL || 5 * 60000;
    this.guildTracking = new Map(); // guildId -> lastActivity timestamp
    this.avatarThreads = new Map(); // guildId -> avatarId -> threadId
    this.lastActiveGuild = new Map(); // avatarId -> guildId

    this.lastMessageTime = Date.now();
    this.IDLE_TIMEOUT = 30000; // 30 seconds
    this.idleCheckInterval = null;

    // Bind the method to this instance
    this.updateLastMessageTime = this.updateLastMessageTime.bind(this);

    this.avatarService = avatarService; // Add this line - it was missing
    this.aiService = aiService; // Add this line - it was missing
  }

  async setupWithRetry(attempt = 1) {
    try {
      await this.setup();
      this.setupComplete = true;
      this.isConnected = true;
      this.logger.info('ChatService setup completed successfully');
    } catch (error) {
      this.logger.error(`Setup attempt ${attempt} failed: ${error.message}`);
      if (attempt < this.retryAttempts) {
        this.logger.info(`Retrying setup in ${this.retryDelay}ms...`);
        setTimeout(() => this.setupWithRetry(attempt + 1), this.retryDelay);
      } else {
        this.logger.error('Max retry attempts reached. ChatService initialization failed.');
        throw error;
      }
    }
  }

  async setupDatabase(mongoClient) {
    try {
      // Verify database connection
      await mongoClient.db().admin().ping();
      this.logger.info('Database connection verified');

      // Get database reference
      const db = mongoClient.db();

      // Initialize collections if needed
      this.avatarsCollection = db.collection('avatars');
      this.messagesCollection = db.collection('messages');
      this.channelsCollection = db.collection('channels');

      // Ensure indexes
      await Promise.all([
        this.avatarsCollection.createIndex({ name: 1 }),
        this.messagesCollection.createIndex({ timestamp: 1 }),
        this.channelsCollection.createIndex({ lastActive: 1 })
      ]);

      this.logger.info('Database setup completed');
    } catch (error) {
      this.logger.error('Failed to setup database:', error);
      throw error;
    }
  }

  async setup() {
    try {
      await this.setupDatabase(this.mongoClient);
      await this.setupAvatarChannelsAcrossGuilds();
      this.setupReflectionInterval();
      this.setupHealthCheck();
      this.logger.info('ChatService setup completed');
    } catch (error) {
      this.logger.error('Setup failed:', error);
      throw error;
    }
  }

  setupHealthCheck() {
    setInterval(async () => {
      try {
        await this.mongoClient.db().admin().ping();
      } catch (error) {
        this.logger.error('Database connection lost, attempting reconnect...');
        this.isConnected = false;
        this.setupWithRetry();
      }
    }, 30000); // Check every 30 seconds
  }

  // Core service methods
  async checkMessages() {
    const avatars = await this.messageProcessor.getActiveAvatars();
    const validAvatars = avatars.filter(avatar => avatar.id && avatar.name);

    if (validAvatars.length !== avatars.length) {
      this.logger.warn(`${avatars.length - validAvatars.length} avatars were excluded due to missing 'id' or 'name'.`);
    }

    const channels = await this.messageProcessor.getActiveChannels(this.client);

    for (const channel of channels) {
      await this.processChannel(channel, validAvatars);
    }
  }

  async respondAsAvatar(client, channel, avatar, force = false) {
    // Validate channel and channel.id
    if (!channel || !channel.id || typeof channel.id !== 'string') {
      this.logger.error('Invalid channel provided to respondAsAvatar:', channel);
      return;
    }

    this.logger.info(`Attempting to respond as avatar ${avatar?.name} in channel ${channel.id} (force: ${force})`);

    try {
      if (!channel?.guild) {
        this.logger.error('Channel has no guild property');
        return;
      }

      // Ensure avatar has id (use _id if id is not present)
      const avatarId = avatar.id || (avatar._id && avatar._id.toString());

      // Validate avatar object
      if (!avatarId || !avatar?.name) {
        this.logger.error('Invalid avatar object:', JSON.stringify({ ...avatar, id: avatarId }, null, 2));
        return;
      }

      // Add avatar to channel with guild ID
      if (!this.avatarTracker.isAvatarInChannel(channel.id, avatarId)) {
        this.avatarTracker.addAvatarToChannel(channel.id, avatarId, channel.guild.id);
      }

      const shouldRespond = force || await this.decisionMaker.shouldRespond(channel, avatar);

      if (shouldRespond && this.conversationHandler.canRespond(channel.id)) {
        this.logger.info(`${avatar.name} decided to respond in ${channel.id}`);
        await this.conversationHandler.sendResponse(channel, avatar);
        this.updateLastActiveGuild(avatarId, channel.guild.id);
      }
    } catch (error) {
      this.logger.error(`Error in respondAsAvatar: ${error.message}`);
      this.logger.error('Avatar data:', JSON.stringify(avatar, null, 2));
    }
  }

  async start() {
    if (!this.setupComplete) {
      await this.setupWithRetry();
    }

    if (!this.isConnected) {
      throw new Error('ChatService not properly initialized');
    }

    this.logger.info('✅ ChatService started.');
    this.interval = setIntervalAsync(() => this.checkMessages(), this.AMBIENT_CHAT_INTERVAL);
    this.backgroundInterval = setIntervalAsync(() => this.updateBackgroundConversations(), this.BACKGROUND_CHECK_INTERVAL);

    // Add idle check interval
    this.idleCheckInterval = setInterval(() => this.checkForIdleChannels(), 5000); // Check every 5 seconds
  }

  async stop() {
    this.logger.info('Stopping ChatService...');
    clearInterval(this.healthCheckInterval);

    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
    }

    if (this.interval) {
      clearInterval(this.interval);
    }

    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }

    try {
      await this.mongoClient.close(true);
      this.logger.info('Database connection closed');
    } catch (error) {
      this.logger.error(`Error closing database connection: ${error.message}`);
    }

    this.isConnected = false;
  }

  async updateBackgroundConversations() {
    try {
      const avatars = await this.avatarService.getAllAvatars();
      if (!avatars.length) return;

      const allChannels = await this.messageProcessor.getActiveChannels(this.client);
      const channelsToUpdate = this.backgroundManager.getNextChannelsToUpdate(allChannels);

      for (const channel of channelsToUpdate) {
        // Select a random avatar for this channel
        const avatarsInChannel = this.avatarTracker.getAvatarsInChannel(channel.id);
        const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];

        // Use the existing decision maker with force=false
        await this.respondAsAvatar(this.client, channel, randomAvatar, false);

        this.logger.error(`Error in background conversations: ${error.message}`);
      }
    } catch (error) {
      this.logger.error(`Error in background conversations: ${error.message}`);
    }
  }

  async setupAvatarChannelsAcrossGuilds() {
    try {
      const guilds = await this.client.guilds.fetch();

      for (const [guildId, guild] of guilds) {
        const fetchedGuild = await guild.fetch();
        let avatarChannel = fetchedGuild.channels.cache.find(c => c.name === 'avatars');

        if (!avatarChannel) {
          avatarChannel = await fetchedGuild.channels.create({
            name: 'avatars',
            topic: 'Avatar reflections and cross-guild interactions'
          });
        }

        this.guildTracking.set(guildId, Date.now());

        if (!this.avatarThreads.has(guildId)) {
          this.avatarThreads.set(guildId, new Map());
        }
      }
    } catch (error) {
      this.logger.error('Failed to setup avatar channels:', error);
    }
  }

  async introduceAvatar(avatar, guildId) {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const avatarChannel = guild.channels.cache.find(c => c.name === 'avatars');

      if (!avatarChannel) return null;

      const thread = await avatarChannel.threads.create({
        name: `${avatar.name}'s Space`,
        autoArchiveDuration: 60,
      });

      this.avatarThreads.get(guildId).set(avatar.id, thread.id);

      const introduction = `# ${avatar.name} ${avatar.emoji}\n\n` +
        `**Description:** ${avatar.description}\n\n` +
        `**Personality:** ${avatar.personality}\n\n` +
        `**Self Introduction:**\n${avatar.dynamicPersonality}\n\n` +
        `**Image:** ${avatar.imageUrl}`;

      await thread.send(introduction);
      return thread;
    } catch (error) {
      this.logger.error(`Failed to introduce avatar ${avatar.name} in guild ${guildId}:`, error);
    }
  }

  updateLastActiveGuild(avatarId, guildId) {
    this.lastActiveGuild.set(avatarId, guildId);
    this.guildTracking.set(guildId, Date.now());
  }

  async generateCrossGuildReflection(avatar) {
    const allChannels = this.avatarTracker.getAvatarChannels(avatar.id);
    const recentInteractions = await this.getRecentCrossGuildInteractions(avatar.id, allChannels);

    const reflectionPrompt = `Based on your interactions across multiple communities:
      1. What patterns or themes have you noticed?
      2. How have different communities shaped your perspective?
      3. What connections have you made with others?
      4. What are your current thoughts and feelings?
      
      Recent interactions: ${JSON.stringify(recentInteractions)}`;

    const reflection = await this.aiService.chat([
      { role: 'system', content: `You are ${avatar.name}. ${avatar.personality}\nPrevious reflections summary: ${avatar.reflectionsSummary || 'None yet.'}` },
      { role: 'user', content: reflectionPrompt }
    ]);

    // Post reflection in last active guild
    const lastGuildId = this.lastActiveGuild.get(avatar.id);
    if (lastGuildId && this.avatarThreads.get(lastGuildId)?.has(avatar.id)) {
      const threadId = this.avatarThreads.get(lastGuildId).get(avatar.id);
      const thread = await this.client.channels.fetch(threadId);
      await thread.send(`## Cross-Guild Reflection\n${reflection}`);
    }

    const reflectionData = {
      timestamp: Date.now(),
      reflection,
      guildName: this.client.guilds.cache.get(lastGuildId)?.name || 'Unknown Guild'
    };

    // Update avatar's reflection history
    if (!avatar.reflectionHistory) avatar.reflectionHistory = [];
    avatar.reflectionHistory.unshift(reflectionData);
    avatar.reflectionHistory = avatar.reflectionHistory.slice(0, this.REFLECTION_SUMMARY_LIMIT);

    // Create consolidated summary
    avatar.reflectionsSummary = avatar.reflectionHistory
      .map(r => `[${new Date(r.timestamp).toLocaleDateString()}] ${r.guildName}: ${r.reflection}`)
      .join('\n\n');

    await this.avatarService.updateAvatar(avatar);

    return reflection;
  }

  async getRecentCrossGuildInteractions(avatarId, channelIds) {
    const recentMessages = [];
    for (const channelId of channelIds) {
      const channel = await this.client.channels.fetch(channelId);
      const messages = await channel.messages.fetch({ limit: 20 });
      const guildMessages = messages.map(m => ({
        content: m.content,
        author: m.author.username,
        guildName: channel.guild.name,
        channelName: channel.name
      }));
      recentMessages.push(...guildMessages);
    }
    return recentMessages;
  }

  async setupAvatarChannel() {
    try {
      const guild = this.client.guilds.cache.first();
      let avatarChannel = guild.channels.cache.find(c => c.name === 'avatars');

      if (!avatarChannel) {
        avatarChannel = await guild.channels.create({
          name: 'avatars',
          topic: 'Avatar introductions and reflections'
        });
      }

      this.avatarChannelId = avatarChannel.id;
    } catch (error) {
      this.logger.error('Failed to setup avatar channel:', error);
    }
  }

  async generateReflection(avatar) {
    const channels = this.avatarTracker.getAvatarChannels(avatar.id);
    const recentMessages = await Promise.all(
      channels.map(async channelId => {
        const channel = await this.client.channels.fetch(channelId);
        const messages = await channel.messages.fetch({ limit: 50 });
        return messages.map(m => ({
          content: m.content,
          author: m.author.username
        }));
      })
    );

    const prompt = `Based on these recent interactions, reflect on your experiences and growth. What have you learned? What connections have you made? Share your thoughts and feelings.`;

    const reflection = await this.aiService.chat([
      { role: 'system', content: `You are ${avatar.name}. ${avatar.personality}` },
      { role: 'user', content: prompt }
    ]);

    const thread = await this.client.channels.fetch(avatar.threadId);
    await thread.send(`## Personal Reflection\n${reflection}`);
  }

  setupReflectionInterval() {
    setInterval(async () => {
      const avatars = await this.messageProcessor.getActiveAvatars();
      for (const avatar of avatars) {
        await this.generateReflection(avatar);
      }
    }, this.REFLECTION_INTERVAL);
  }

  updateLastMessageTime() {
    this.lastMessageTime = Date.now();
  }

  async checkForIdleChannels() {
    const now = Date.now();
    if (now - this.lastMessageTime >= this.IDLE_TIMEOUT) {
      const activeChannels = await this.messageProcessor.getActiveChannels(this.client);
      if (activeChannels.length === 0) return;

      // Pick a random channel
      const randomChannel = activeChannels[Math.floor(Math.random() * activeChannels.length)];

      // Get available avatars
      const avatars = await this.messageProcessor.getActiveAvatars();
      if (avatars.length === 0) return;

      // Pick a random avatar
      const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];

      this.logger.info(`🎲 Initiating random conversation in ${randomChannel.name} with ${randomAvatar.name}`);
      await this.respondAsAvatar(this.client, randomChannel, randomAvatar, true);

      // Reset the timer
      this.updateLastMessageTime();
    }
  } // Added closing brace for checkForIdleChannels

  markChannelActivity(channelId, mentionsAvatar = false) {
    // Track message count for attention decay
    this.attentionManager.trackMessage(channelId);
    
    const avatarsInChannel = this.avatarTracker.getAvatarsInChannel(channelId);
    for (const avatarId of avatarsInChannel) {
      const increase = mentionsAvatar ? 0.4 : 0.1;
      this.attentionManager.increaseAttention(channelId, avatarId, increase);
      this.logger.info(`${avatarId} now paying more attention to ${channelId}`);
    }

    for (const avatarId of avatarsInChannel) {
      const increase = mentionsAvatar ? 0.4 : 0.1;
      this.attentionManager.increaseAttention(channelId, avatarId, increase);
      this.logger.error('Invalid channelId provided to handleMention:', channelId);
    }
    return;
  }


  handleMention(channelId, avatarId) {
    this.attentionManager.handleMention(channelId, avatarId);
  }
}