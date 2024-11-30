
import { ConversationHandler } from './ConversationHandler.mjs';
import { DecisionMaker } from './DecisionMaker.mjs';
import { MessageProcessor } from './MessageProcessor.mjs';
import { AvatarTracker } from './AvatarTracker.mjs';
import { BackgroundConversationManager } from './BackgroundConversationManager.mjs'; // Added import
import { setIntervalAsync } from 'set-interval-async/fixed';

import { DungeonService } from '../dungeon/DungeonService.mjs'; // Added import
import { DungeonProcessor } from '../dungeon/DungeonProcessor.mjs'; // Added import
import { getRecentMessages } from '../discordService.mjs';

export class ChatService {
  constructor(client, db, options = {}) {
    this.db = db;
    if (!client) {
      throw new Error('Discord client is required');
    }

    this.client = client;
    // Ensure logger exists, create no-op logger if not provided
    this.logger = options.logger || {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {}
    };

    // Initialize core services with logger
    this.avatarTracker = new AvatarTracker(this.client, this.logger, this.db);
    this.dungeonService = new DungeonService(client, this.logger, this.avatarTracker);
    this.conversationHandler = new ConversationHandler(
      client, 
      options.aiService, 
      this.logger, 
      this.avatarTracker, 
      options.avatarService,
      this.dungeonService
    );
    this.decisionMaker = new DecisionMaker(options.aiService, this.logger);
    this.messageProcessor = new MessageProcessor(options.avatarService);

    this.retryAttempts = 3;
    this.retryDelay = 5000; // 5 seconds

    // Track initialization state
    this.setupComplete = false;
    this.isConnected = false;

    this.backgroundManager = new BackgroundConversationManager(this.logger);
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

    // Store services from options
    this.avatarService = options.avatarService;
    this.aiService = options.aiService;
    
    if (!this.avatarService || !this.aiService) {
      throw new Error('avatarService and aiService are required');
    }

    this.responseQueue = new Map(); // channelId -> Set of avatarIds to respond
    this.responseTimeout = null;
    this.RESPONSE_DELAY = 3000; // Wait 3 seconds before processing responses

    this.dungeonProcessor = new DungeonProcessor(this.dungeonService, this.logger);

    // Remove complex tracking properties
    this.AMBIENT_CHECK_INTERVAL = 60000; // Check for ambient responses every minute
    this.setupAmbientResponses();
  }

  async setupWithRetry(attempt = 1) {

    try {
      this.logger.info(`Attempting setup (attempt ${attempt})`);
      await this.setup();
      
      // Initialize avatars in channels after setup
      const avatars = await this.avatarService.getAllAvatars();
      const guilds = this.client.guilds.cache.values();
      
      for (const guild of guilds) {
        const channels = guild.channels.cache
          .filter(c => c.isTextBased() && !c.isThread())
          .values();
          
        for (const channel of channels) {
          for (const avatar of avatars) {
            // Add avatars to general channels by default
            if (channel.name.includes('general')) {
              const avatarId = avatar.id || avatar._id?.toString();
              this.avatarTracker.addAvatarToChannel(avatarId, channel.id,  guild.id);
            }
          }
        }
      }
      
      this.setupComplete = true;
      this.isConnected = true;
      this.logger.info('ChatService setup completed successfully');
    } catch (error) {
      this.logger.error(`Setup attempt ${attempt} failed: ${error.message}`);
      if (attempt < this.retryAttempts) {
        this.logger.info(`Retrying setup in ${this.retryDelay}ms...`);
        return new Promise(resolve => {
          setTimeout(() => this.setupWithRetry(attempt + 1).then(resolve), this.retryDelay);
        });
      }
      throw new Error('ChatService initialization failed after max retries');
    }
  }

  async setupDatabase() {
    try {
      // Get database reference
      const db = this.db;

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
      await this.setupAvatarChannelsAcrossGuilds();
      await this.dungeonService.initializeDatabase(); // Add this line
      this.setupReflectionInterval();
      this.logger.info('ChatService setup completed');
    } catch (error) {
      this.logger.error('Setup failed:', error);
      throw error;
    }
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

    await this.dungeonProcessor.checkPendingActions();
  }

  async getRecentMessages(channelId) {
    try {
      const messages = await this.db.collection('messages')
        .find({ channelId })
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray();

      return messages.reverse();
    } catch (error) {
      this.logger.error(`Failed to fetch recent messages for channel ${channelId}:`, error);
      return [];
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
        this.avatarTracker.addAvatarToChannel(avatar.id, channel.id, channel.guild.id);
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
    try {
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
        const channelIds = this.avatarTracker.getAvatarChannels(randomAvatar.id);
        await this.conversationHandler.generateNarrative(
          randomAvatar,
          { channelIds, type: 'inner_monologue',  }
        );
      }

      this.logger.info('✅ ChatService started.');
      this.interval = setIntervalAsync(() => this.checkMessages(), this.AMBIENT_CHAT_INTERVAL);
      this.backgroundInterval = setIntervalAsync(() => this.updateBackgroundConversations(), this.BACKGROUND_CHECK_INTERVAL);
      this.idleCheckInterval = setInterval(() => this.checkForIdleChannels(), 5000);
    } catch (error) {
      this.logger.error(`Failed to start ChatService: ${error.message}`);
      throw error;
    }
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
    
    // Clear intervals first
    if (this.backgroundInterval) clearInterval(this.backgroundInterval);
    if (this.interval) clearInterval(this.interval);
    if (this.idleCheckInterval) clearInterval(this.idleCheckInterval);

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

  shouldRespond(channelId, avatarId, force = false) {
    try {
      if (force) return true;

      const attention = this.avatarTracker.getAttention(channelId, avatarId);
      const currentLevel = this.avatarTracker.decayAttention(channelId, avatarId);
      
      // Implement probabilistic response based on attention level
      const responseChance = Math.min(0.8, 0.1 + (currentLevel * 0.1));
      const shouldRespond = Math.random() < responseChance;

      this.logger.debug(`Avatar ${avatarId} attention level: ${currentLevel}, response chance: ${responseChance}`);
      return shouldRespond;

    } catch (error) {
      this.logger.error(`Error in shouldRespond: ${error.message}`);
      return false;
    }
  }

  setupAmbientResponses() {
    setInterval(async () => {
      const channels = await this.messageProcessor.getActiveChannels(this.client);
      
      for (const channel of channels) {
        const avatarsInChannel = this.avatarTracker.getAvatarsInChannel(channel.id);

    
        // sort by last response time
        avatarsInChannel.sort((a, b) => {
          const lastResponseA = this.decisionMaker.getRecentResponseTime(channel.id, a);
          const lastResponseB = this.decisionMaker.getRecentResponseTime(channel.id, b);
          return lastResponseA - lastResponseB;
        });

        
        // Always respond as the three most recent avatars
        for (let i = 0; i < Math.min(3, avatarsInChannel.length); i++) {
          const avatarId = avatarsInChannel[i];
          const avatar = await this.avatarService.getAvatar(avatarId);
          if (avatar) {
            await this.respondAsAvatar(channel, avatar, false);
          }
        }

        // 50% chance to respond as the next 5
        for (let i = 3; i < Math.min(8, avatarsInChannel.length); i++) {
          if (Math.random() < 0.5) {
            const avatarId = avatarsInChannel[i];
            const avatar = await this.avatarService.getAvatar(avatarId);
            if (avatar) {
              await this.respondAsAvatar(channel, avatar, false);
            }
          }
        }
      }
    }, this.AMBIENT_CHECK_INTERVAL);
  }
}