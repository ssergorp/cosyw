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

    this.avatarTracker = new AvatarTracker(this.client, this.logger);
    this.attentionManager = new AttentionManager(logger);
    this.conversationHandler = new ConversationHandler(client, aiService, logger, this.avatarTracker, avatarService);
    this.decisionMaker = new DecisionMaker(aiService, logger, this.attentionManager);
    this.messageProcessor = new MessageProcessor(avatarService);

    this.mongoClient = mongoClient;
    this.retryAttempts = 3;
    this.retryDelay = 5000; // 5 seconds
    this.isConnected = false;

    this.setupComplete = false;

    this.backgroundManager = new BackgroundConversationManager(logger);
    this.BACKGROUND_CHECK_INTERVAL = 5 * 60000; // Check every minute
    this.backgroundInterval = null;

    this.REFLECTION_INTERVAL = 1 * 3600000; // 1 hour
    this.reflectionTimer = 0; 
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

    this.responseQueue = new Map(); // channelId -> Set of avatarIds to respond
    this.responseTimeout = null;
    this.RESPONSE_DELAY = 3000; // Wait 3 seconds before processing responses
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
    // Validate channel and avatar
    if (!channel?.id || !avatar?.id) {
      this.logger.error('Invalid channel or avatar provided to respondAsAvatar');
      return;
    }

    try {
      this.logger.info(`Attempting to respond as avatar ${avatar.name} in channel ${channel.id} (force: ${force})`);
      
      // Always track that the avatar exists in this channel
      if (!this.avatarTracker.isAvatarInChannel(channel.id, avatar.id)) {
        this.avatarTracker.addAvatarToChannel(channel.id, avatar.id, channel.guild.id);
        this.attentionManager.increaseAttention(channel.id, avatar.id, 1);
      }

      // Check if response is allowed based on cooldowns/decisions
      const shouldRespond = force || await this.decisionMaker.shouldRespond(channel, avatar);
      
      if (shouldRespond) {
        this.logger.info(`${avatar.name} decided to respond in ${channel.id}`);
        await this.conversationHandler.sendResponse(channel, avatar);
        this.updateLastActiveGuild(avatar.id, channel.guild.id);
        // Track the response in DecisionMaker
        this.decisionMaker.trackResponse(channel.id, avatar.id);
      }

    } catch (error) {
      this.logger.error(`Error in respondAsAvatar: ${error.message}`);
      this.logger.error('Avatar data:', avatar);
    }
  }

  async start() {
    if (!this.setupComplete) {
      await this.setupWithRetry();
    }

    if (!this.isConnected) {
      throw new Error('ChatService not properly initialized');
    }

    // Force a random reflection on startup
    const avatars = await this.messageProcessor.getActiveAvatars();
    if (avatars.length > 0) {
      const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];
      this.logger.info(`🎯 Forcing startup reflection for ${randomAvatar.name}`);
      await this.generateReflection(randomAvatar);
      await this.conversationHandler.generateNarrative(randomAvatar, { type: 'inner_monologue' });
    }

    this.logger.info('✅ ChatService started.');
    this.interval = setIntervalAsync(() => this.checkMessages(), this.AMBIENT_CHAT_INTERVAL);
    this.backgroundInterval = setIntervalAsync(() => this.updateBackgroundConversations(), this.BACKGROUND_CHECK_INTERVAL);
    this.idleCheckInterval = setInterval(() => this.checkForIdleChannels(), 5000);
  }

  async triggerStartupReflection() {
    try {
      const avatars = await this.messageProcessor.getActiveAvatars();
      if (!avatars.length) return;

      const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];
      this.logger.info(`🌅 Triggering startup reflection for ${randomAvatar.name}`);
      await this.generateReflection(randomAvatar);
    } catch (error) {
      this.logger.error('Error triggering startup reflection:', error);
    }
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

  updateLastActiveGuild(avatarId, guildId) {
    this.lastActiveGuild.set(avatarId, guildId);
    this.guildTracking.set(guildId, Date.now());
  }

  async generateReflection(avatar) {
    const channels = this.avatarTracker.getAvatarChannels(avatar.id);
    await this.conversationHandler.generateNarrative(avatar, {
      type: 'reflection',
      crossGuild: true,
      channelIds: channels
    });
  }

  setupReflectionInterval() {
    setInterval(async () => {
      const avatars = await this.messageProcessor.getActiveAvatars();
      for (const avatar of avatars) {
        await this.generateReflection(avatar);
      }
    }, this.REFLECTION_INTERVAL);
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

  updateLastMessageTime() {
    this.lastMessageTime = Date.now();
  }

  async checkForIdleChannels() {
    const now = Date.now();
    if (now - this.lastMessageTime >= this.IDLE_TIMEOUT) {
      // Check for inner monologue updates first
      const avatars = await this.messageProcessor.getActiveAvatars();
      await this.conversationHandler.checkIdleUpdate(avatars);

      // Pick a random channel
      const activeChannels = await this.messageProcessor.getActiveChannels(this.client);
      if (activeChannels.length === 0) return;

      const randomChannel = activeChannels[Math.floor(Math.random() * activeChannels.length)];

      // Use the already fetched avatars array instead of fetching again
      if (avatars.length === 0) return;

      // Pick a random avatar
      const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];

      this.logger.info(`🎲 Initiating random conversation in ${randomChannel.name} with ${randomAvatar.name}`);
      await this.respondAsAvatar(this.client, randomChannel, randomAvatar, true);

      // Reset the timer
      this.updateLastMessageTime();
    }
  }

  markChannelActivity(channelId, mentionsAvatar = false) {
    // Track message count for attention decay
    this.attentionManager.trackMessage(channelId);
    
    // Get recently active avatars and increase their attention
    const recentlyActive = this.decisionMaker.getRecentlyActiveAvatars(channelId);
    for (const avatarId of recentlyActive) {
      const increase = 0.15; // Smaller increase for non-mentioned avatars
      this.attentionManager.increaseAttention(channelId, avatarId, increase);
      this.logger.info(`Increasing attention for recently active avatar ${avatarId} in ${channelId}`);
    }

    // Also handle avatars in channel as before
    const avatarsInChannel = this.avatarTracker.getAvatarsInChannel(channelId);
    for (const avatarId of avatarsInChannel) {
      const increase = mentionsAvatar ? 0.4 : 0.1;
      this.attentionManager.increaseAttention(channelId, avatarId, increase);
      this.logger.info(`${avatarId} now paying more attention to ${channelId}`);
    }

    for (const avatarId of avatarsInChannel) {
      const increase = mentionsAvatar ? 0.4 : 0.1;
      this.attentionManager.increaseAttention(channelId, avatarId, increase);
    }
    return;
  }


  handleMention(channelId, avatarId) {
    this.attentionManager.handleMention(channelId, avatarId);
  }
}