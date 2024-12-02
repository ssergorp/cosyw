
import { ConversationHandler } from './ConversationHandler.mjs';
import { DecisionMaker } from './DecisionMaker.mjs';
import { MessageProcessor } from './MessageProcessor.mjs';
import { setIntervalAsync } from 'set-interval-async/fixed';

import { DungeonService } from '../dungeon/DungeonService.mjs'; // Added import
import { DungeonProcessor } from '../dungeon/DungeonProcessor.mjs'; // Added import



export class ChatService {
  constructor(client, db, options = {}) {
    this.db = db;
    this.avatarService = options.avatarService;
    if (!client) {
      throw new Error('Discord client is required');
    }

    this.client = client;
    // Ensure logger exists, create no-op logger if not provided
    this.logger = options.logger || {
      info: () => { },
      error: () => { },
      warn: () => { },
      debug: () => { }
    };

    // Initialize core services with logger
    this.dungeonService = new DungeonService(
      client, this.logger, this.avatarService
    ); // Added initialization
    this.conversationHandler = new ConversationHandler(
      client,
      options.aiService,
      this.logger,
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
  }

  async setupWithRetry(attempt = 1) {

    try {
      this.logger.info(`Attempting setup (attempt ${attempt})`);
      await this.setup();

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

      // update active avatars
      this.UpdateActiveAvatars();
    } catch (error) {
      this.logger.error('Setup failed:', error);
      throw error;
    }
  }

  // Core service methods
  async checkMessages() {
    const avatars = await this.messageProcessor.getActiveAvatars();
    const validAvatars = avatars.filter(avatar => avatar._id && avatar.name);

    if (validAvatars.length !== avatars.length) {
      this.logger.warn(`${avatars.length - validAvatars.length} avatars were excluded due to missing 'id' or 'name'.`);
    }
    await this.dungeonProcessor.checkPendingActions();
  }

  async getLastMentionedAvatars(messages, avatars) {
      // for each message, check if any avatars are mentioned
      const mentionedAvatars = new Set();
      for (const message of messages) {
        for (const avatar of avatars) {
          if (message.content.includes(avatar.name)) {
            mentionedAvatars.add(avatar._id);
          }
        }
        if (mentionedAvatars.size >= 3) {
          break;
        }
      }
      return [...mentionedAvatars];
  }

  // find the 12 most mentioned 
  async getTopMentions(messages, avatars) {
    const mentions = new Map();
    for (const message of messages) {
      const mentionedAvatars = await this.avatarService.getMentionedAvatars(message.content);
      for (const avatar of mentionedAvatars) {
        if (mentions.has(avatar._id)) {
          mentions.set(avatar._id, mentions.get(avatar._id) + 1);
        } else {
          mentions.set(avatar._id, 1);
        }
      }
    }

    // if there are no mentions, select a hundred random avatars
    if (mentions.size === 0) {
      return avatars
        .sort(() => Math.random() - 0.5)
        .slice(0, 12)
        .map(avatar => avatar._id);
    }

    return [...mentions.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 12)
      .map(([_id]) => _id);
  }

  // get the most recent limit messages prior to timestamp if provided or now
  async getRecentMessagesFromDatabase(channelId = null, limit = 100, timestamp = null) {
    try {
      const query = { channelId: channelId || { $exists: true } };
      if (timestamp) {
        query.timestamp = { $lt: timestamp };
      }

      const messages = await this.db.collection('messages')
        .find(query)
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

      return messages.reverse();
    } catch (error) {
      this.logger.error(`Failed to fetch recent messages for channel ${channelId}:`, error);
      return [];
    }
  }

  async UpdateActiveAvatars() {
    const avatars = await this.avatarService.getAllAvatars();
    const messages = await this.getRecentMessagesFromDatabase(null, 100);
    const topAvatars = await this.getTopMentions(messages, avatars);

    // shuffle the avatars
    topAvatars.sort(() => Math.random() - 0.5);

    // discard the bottom 6
    topAvatars.splice(6);

    // respond as each of the top 6 avatars
    for (const avatarId of topAvatars) {
      const avatar = avatars.find(a => a.id === avatarId);
      if (!avatar) {
        this.logger.error(`Avatar ${avatarId} not found`);
        continue;
      }
      const channel = this.client.channels.cache.get(avatar.channelId);
      if (!channel) {
        this.logger.error(`Channel ${avatar.channelId} not found`);
        continue;
      }

      try {
        await this.respondAsAvatar(channel, avatar, false);
      } catch (error) {
        this.logger.error(`Error responding as avatar ${avatar.name}: ${error.message}`);
      }

    }

    // schedule the next update
    setTimeout(() => this.UpdateActiveAvatars(), 15 * 60000);
  }

  async respondAsAvatar(channel, avatar, force = false) {
    // Validate channel and avatar
    if (!channel?.id) {
      this.logger.error('Invalid channel or avatar provided to respondAsAvatar');
      return;
    }

    try {
      this.logger.info(`Attempting to respond as avatar ${avatar.name} in channel ${channel.id} (force: ${force})`);
      let decision = true;
      try {
        decision = await this.decisionMaker.shouldRespond(channel, avatar, this.client);
      } catch (error) {
        this.logger.error(`Error in decision maker: ${error.message}`);
      }

      // Check if response is allowed based on cooldowns/decisions
      const shouldRespond = force || decision;

      if (shouldRespond) {
        this.logger.info(`${avatar.name} decided to respond in ${channel.id}`);
        await this.conversationHandler.sendResponse(channel, avatar);
        this.updateLastActiveGuild(avatar._id, channel.guild.id);
        // Track the response in DecisionMaker
        this.decisionMaker.trackResponse(channel.id, avatar._id);
      }

    } catch (error) {
      this.logger.error(`Error in respondAsAvatar: ${error.message}`);
      this.logger.error('Avatar data:', avatar);
      throw error;
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
        const channelIds = [randomAvatar.channelId];
        await this.conversationHandler.generateNarrative(
          randomAvatar,
          { channelIds, type: 'inner_monologue', }
        );
      }

      this.logger.info('✅ ChatService started.');
      this.interval = setIntervalAsync(() => this.checkMessages(), this.AMBIENT_CHAT_INTERVAL);
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
    if (this.interval) clearInterval(this.interval);

    this.isConnected = false;
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
    const channelIds = [avatar.channelId];
    await this.conversationHandler.generateNarrative(avatar, {
      type: 'reflection',
      crossGuild: true, channelIds
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
}