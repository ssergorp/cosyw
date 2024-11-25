import { sendAsWebhook } from './discordService.mjs';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async/fixed';
import { extractJSON } from './utils.mjs';
import stringSimilarity from 'string-similarity';
/**
 * ChatService handles periodic checking of messages and avatar interactions.
 */
export class ChatService {
  /**
   * @param {Client} client - The Discord client instance.
   * @param {MongoClient} mongoClient - The MongoDB client instance.
   * @param {Object} options - Additional options.
   * @param {Logger} logger - The Winston logger instance.
   * @param {AvatarGenerationService} avatarService - The avatar service instance.
   * @param {AIService} aiService - The Ai service instance.
   */
  constructor(client, mongoClient, { logger, avatarService, aiService }) {
    this.client = client;
    this.mongoClient = mongoClient;
    this.logger = logger;
    this.avatarService = avatarService;
    this.aiService = aiService;

    const db = this.mongoClient.db(process.env.MONGO_DB_NAME || 'discord-bot');
    this.messagesCollection = db.collection('messages');
    this.processedMessagesCollection = db.collection('processedMessages'); // To track processed messages

    this.interval = null;
    this.intervalTime = 30000; // 30 seconds (corrected from 1000 ms)
    this.lastMentionCheck = Date.now() - 30000;

    // Map to track last responded channel per avatar
    this.avatarLastChannelMap = new Map();

    // Initialize rate limiters and state trackers
    this.globalBotRateLimiter = {
      lastBotToBotResponse: 0,
      lastInactiveResponse: 0
    };

    this.activeConversations = new Map(); // channelId -> number of active bot responses
    this.channelActivity = new Map(); // channelId -> consecutive bot message count

    this.debounceMap = new Map(); // channelId -> timestamp of last human message
    this.avatarLastResponded = new Map(); // avatarId -> timestamp of last response
    this.avatarCycleIndex = new Map(); // channelId -> current avatar index for cycling

    // Add heightened attention tracking
    this.heightenedAttention = new Map(); // avatarId -> { channelId, expiryTime }
    this.ATTENTION_DURATION = 30000; // 30 seconds of heightened attention

    // Add last interaction tracking
    this.lastUserInteraction = new Map(); // avatarId -> { userId, timestamp }
    this.ATTENTION_DURATION = 30000; // 30 seconds
    this.channelCooldowns = new Map(); // channelId -> timestamp
    this.CHANNEL_COOLDOWN = 5000; // 5 seconds between responses in same channel
  }

  /**
   * Starts the ChatService.
   */
  start() {
    this.logger.info('📈 ChatService started.');
    this.interval = setIntervalAsync(() => this.checkMessages(), this.intervalTime);
  }

  /**
   * Stops the ChatService.
   */
  async stop() {
    if (this.interval) {
      await clearIntervalAsync(this.interval);
      this.logger.info('📉 ChatService stopped.');
    }
  }


  /**
  * Main message checking logic that runs on interval
  */
  async checkMessages() {
    try {
      const currentTime = Date.now();
      const BOT_TO_BOT_RATE_LIMIT = 60 * 1000; // 1 minute
      const MAX_ACTIVE_RESPONSES = 3;
      const ROLLING_RESPONSE_INTERVAL = 60 * 1000; // 1 minute for inactive channels
      const DEBOUNCE_THRESHOLD = 3000; // 3 seconds
      // Add tracking for last bot-to-bot interaction
      if (!this.lastBotToBotInteraction) {
        this.lastBotToBotInteraction = 0;
      }

      const guilds = this.client.guilds.cache;
      const avatars = await this.avatarService.getAllAvatars();

      // Skip processing if within bot-to-bot rate limit
      const timeSinceLastBotInteraction = currentTime - this.lastBotToBotInteraction;
      if (timeSinceLastBotInteraction < BOT_TO_BOT_RATE_LIMIT) {
        this.logger.debug(`Skipping bot check - rate limited (${Math.floor((BOT_TO_BOT_RATE_LIMIT - timeSinceLastBotInteraction) / 1000)}s remaining)`);
        return;
      }

      // Track active and inactive channels
      const activeChannels = []; // Array of { channelId, mentionedAvatars }
      const inactiveChannels = []; // Array of { channelId, mentionedAvatars }

      // Process all channels
      for (const guild of guilds.values()) {
        const channels = guild.channels.cache.filter(channel => channel.isTextBased());

        for (const channel of channels.values()) {
          const recentMessages = await channel.messages.fetch({ limit: 50 });
          const humanMessages = recentMessages.filter(msg => !msg.author.bot);
          const botMessages = recentMessages.filter(msg => msg.author.bot);

          // Check for messages that should trigger heightened attention
          for (const msg of humanMessages.values()) {
            const mentionedAvatars = this.extractMentionedAvatars(msg.content, avatars);
            mentionedAvatars.forEach(avatar => {
              this.setHeightenedAttention(avatar._id, channel.id);
            });
          }

          // Process messages for avatars in heightened attention mode
          for (const avatar of avatars) {
            if (this.isInHeightenedAttention(avatar.id, channel.id)) {
              if (humanMessages.size > 0) {
                await this.respondAsAvatar(this.client, channel, avatar, true);
              }
            }
          }

          // Determine if the channel is inactive
          const isInactive = this.isChannelInactive(botMessages);

          if (!isInactive && humanMessages.size > 0) {
            // Active channel: check for mentioned avatars
            const mentionedAvatars = this.extractMentionedAvatars(
              humanMessages.map(m => m.content).join(' ').toLowerCase(),
              avatars
            );
            if (mentionedAvatars.size > 0) {
              activeChannels.push({ channelId: channel.id, mentionedAvatars });

              // Update debounce map
              const lastHumanMessage = humanMessages.first().createdTimestamp;
              const lastDebounce = this.debounceMap.get(channel.id) || 0;
              if (currentTime - lastDebounce > DEBOUNCE_THRESHOLD) {
                this.debounceMap.set(channel.id, lastHumanMessage);
              }
            }
          } else {
            // Inactive channel: check if rolling response is due
            const lastResponse = this.globalBotRateLimiter.lastInactiveResponse || 0;
            if (currentTime - lastResponse >= ROLLING_RESPONSE_INTERVAL) {
              const botMentionedAvatars = this.extractBotMentionedAvatars(botMessages, avatars);
              if (botMentionedAvatars.size > 0) {
                inactiveChannels.push({ channelId: channel.id, mentionedAvatars: botMentionedAvatars });
              }
            }
          }
        }
      }

      // Handle active channels first
      for (const { channelId, mentionedAvatars } of activeChannels) {
        const lastDebounce = this.debounceMap.get(channelId) || 0;
        if (currentTime - lastDebounce < DEBOUNCE_THRESHOLD) {
          // Skip processing to debounce
          continue;
        }

        const channel = this.client.channels.cache.get(channelId);
        if (!channel) continue;

        const currentActive = this.activeConversations.get(channelId) || 0;
        const availableResponses = MAX_ACTIVE_RESPONSES - currentActive;

        if (availableResponses <= 0) continue;

        const avatarsToRespond = this.getNextAvatars(channelId, mentionedAvatars, availableResponses);

        for (const avatar of avatarsToRespond) {
          await this.respondAsAvatar(this.client, channel, avatar, false);
          this.avatarLastChannelMap.set(avatar.id, channelId);
          this.activeConversations.set(channelId, (this.activeConversations.get(channelId) || 0) + 1);
          this.logger.info(`🤖 (Active) Responded as ${avatar.name} in ${channelId}`);
        }
      }

      // Handle inactive channels with rolling responses
      if (currentTime - this.globalBotRateLimiter.lastInactiveResponse >= ROLLING_RESPONSE_INTERVAL) {
        for (const { channelId, mentionedAvatars } of inactiveChannels) {
          const channel = this.client.channels.cache.get(channelId);
          if (!channel) continue;

          const avatar = this.getNextInactiveAvatar(mentionedAvatars);
          if (avatar) {
            await this.respondAsAvatar(this.client, channel, avatar, true);
            this.avatarLastChannelMap.set(avatar.id, channelId);
            this.globalBotRateLimiter.lastInactiveResponse = currentTime;
            this.lastBotToBotInteraction = currentTime;

            this.logger.info(`🤖 (Inactive) Responded as ${avatar.name} in ${channelId}`);
            break; // Only one inactive response per rolling interval
          }
        }
      }
    } catch (error) {
      this.logger.error(`📛 Error in checkMessages: ${error.message}`);
      throw error;
    }
  }

  /**
   * Retrieves the next set of avatars to respond, cycling through to prevent repetition.
   * @param {string} channelId - The ID of the channel.
   * @param {Set} mentionedAvatars - Set of avatars mentioned.
   * @param {number} limit - Number of avatars to retrieve.
   * @returns {Array} Array of avatar objects.
   */
  getNextAvatars(channelId, mentionedAvatars, limit) {
    const avatarsArray = Array.from(mentionedAvatars);
    const cycleIndex = this.avatarCycleIndex.get(channelId) || 0;
    const selectedAvatars = [];

    for (let i = 0; i < avatarsArray.length && selectedAvatars.length < limit; i++) {
      const index = (cycleIndex + i) % avatarsArray.length;
      const avatar = avatarsArray[index];
      if (!selectedAvatars.includes(avatar)) {
        selectedAvatars.push(avatar);
      }
    }

    this.avatarCycleIndex.set(channelId, (cycleIndex + selectedAvatars.length) % avatarsArray.length);
    return selectedAvatars;
  }

  /**
   * Retrieves the next inactive avatar, ensuring rotation.
   * @param {Set} mentionedAvatars - Set of avatars mentioned.
   * @returns {object|null} Avatar object or null if none found.
   */
  getNextInactiveAvatar(mentionedAvatars) {
    const avatarsArray = Array.from(mentionedAvatars);
    if (avatarsArray.length === 0) return null;

    // Simple rotation logic
    const lastRespondedAvatarId = Array.from(this.avatarLastResponded.values()).pop();
    let nextIndex = 0;
    if (lastRespondedAvatarId) {
      const lastIndex = avatarsArray.findIndex(avatar => avatar.id === lastRespondedAvatarId);
      nextIndex = (lastIndex + 1) % avatarsArray.length;
    }

    const nextAvatar = avatarsArray[nextIndex];
    this.avatarLastResponded.set(nextAvatar.id, Date.now());
    return nextAvatar;
  }

  /**
   * Determines if a channel is inactive based on bot message patterns
   */
  isChannelInactive(botMessages) {
    const BOT_MESSAGE_THRESHOLD = 5;
    if (botMessages.size < BOT_MESSAGE_THRESHOLD) return false;

    const lastMessages = Array.from(botMessages.values()).slice(0, BOT_MESSAGE_THRESHOLD);
    return lastMessages.length === BOT_MESSAGE_THRESHOLD &&
      lastMessages.every(msg => msg.author.bot);
  }

  /**
   * Find avatars mentioned in text using fuzzy matching
   */
  extractMentionedAvatars(text, avatars) {
    const SIMILARITY_THRESHOLD = 0.88; // Adjust threshold as needed
    const words = text.toLowerCase().split(/\s+/);
    const mentionedAvatars = new Set();

    // For each word, find closest matching avatar name
    words.forEach(word => {
      const matches = avatars.map(avatar => ({
        avatar,
        // Check similarity with name and any aliases
        score: Math.max(
          stringSimilarity.compareTwoStrings(word, avatar.name.toLowerCase()),
          avatar.emoji ? stringSimilarity.compareTwoStrings(word, avatar.emoji) : 0
        )
      }));

      // Get best match above threshold
      const bestMatch = matches.reduce((best, current) =>
        current.score > best.score ? current : best,
        { score: 0 }
      );

      if (bestMatch.score >= SIMILARITY_THRESHOLD) {
        mentionedAvatars.add(bestMatch.avatar);
      }
    });

    return mentionedAvatars;
  }

  /**
   * Extracts avatars mentioned by bot messages.
   * @param {Collection} messages - Collection of bot messages.
   * @param {Array} avatars - Array of all avatars.
   * @returns {Set} Set of mentioned avatars.
   */
  extractBotMentionedAvatars(messages, avatars) {
    const mentionedAvatars = new Set();

    for (const msg of messages.values()) {
      if (!msg.author.bot) continue; // Only consider bot messages

      const content = msg.content?.toLowerCase();
      if (!content) continue;

      avatars.forEach(avatar => {
        if (!avatar.name) {
          console.error('Avatar name is missing');
          console.log(avatar);
          return;
        }
        if (content.includes(avatar.name.toLowerCase()) || content.includes(avatar.emoji)) {
          mentionedAvatars.add(avatar);
        } else {
          // Check for name components longer than five letters
          const nameComponents = avatar.name.split(' ').filter(comp => comp.length > 5);
          for (const comp of nameComponents) {
            if (content.includes(comp.toLowerCase())) {
              mentionedAvatars.add(avatar);
              break;
            }
          }
        }
      });
    }

    return mentionedAvatars;
  }

  /**
   * Sends a message as the specified avatar with an inner monologue.
   * This method can be called both for immediate responses and periodic processing.
   * @param {Client} client - The Discord client instance.
   * @param {TextChannel} channel - The Discord text channel.
   * @param {object} avatar - The avatar object.
   * @param {boolean} force - If true, forces a response regardless of AI decision.
   */
  async respondAsAvatar(client, channel, avatar, force = false) {
    try {
      // Check channel cooldown
      const lastResponse = this.channelCooldowns.get(channel.id) || 0;
      if (Date.now() - lastResponse < this.CHANNEL_COOLDOWN) {
        return;
      }

      // Get recent messages
      const recentMessages = await channel.messages.fetch({ limit: 10 });
      const lastHumanMessage = Array.from(recentMessages.values())
        .find(msg => !msg.author.bot);

      if (!lastHumanMessage) return;

      // Update interaction tracking
      this.updateLastInteraction(avatar.id, lastHumanMessage.author.id);

      // Check if in heightened attention mode
      const isHeightened = this.isInHeightenedAttention(avatar.id, channel.id);

      // Check if last message was from this avatar
      const lastMessage = recentMessages.first();
      if (lastMessage?.webhookId && lastMessage.author.username === avatar.name) {
        this.logger.info(`Skipping response as ${avatar.name} was the last speaker in ${channel.id}`);
        return;
      }

      // Format conversation history
      const messages = [];
      recentMessages.reverse().forEach(msg => {
        if (msg.author.username === avatar.name) {
          messages.push({ role: 'assistant', content: `${msg.content}`.replace(`${avatar.name} said: `, '') });
        } else {
          messages.push({ role: 'user', content: `${msg.author.username}: ${msg.content}` });
        }
      });

      if (!force && !isHeightened) {
        // Improved decision making with context
        const shouldRespond = await this.executeExecutiveDecision(client, channel, avatar, lastHumanMessage.author.id);
        if (!shouldRespond.shouldRespond) {
          return;
        }
      }

      // Update channel cooldown after successful response
      this.channelCooldowns.set(channel.id, Date.now());

      // Generate response if decision was YES or force is true
      messages.push({ role: 'user', content: `Reply as ${avatar.name} naturally in a way that advances the story and your goals, with no more than two or three short sentences, *actions*, and emojis.` });
      const avatarResponse = (await this.aiService.chat(messages) || '')
        .trim()
        .replace(`${avatar.name}: `, '');

      if (!avatarResponse || avatarResponse.length === 0) {
        this.logger.info(`No response generated for ${avatar.name} in channel ${channel.id}`);
        return;
      }

      // Send the response
      await sendAsWebhook(client, channel.id, avatarResponse, avatar.name, avatar.imageUrl);
    } catch (error) {
      this.logger.error(`📛 Error in respondAsAvatar: ${error.message}`);
      throw error;
    }
  }

  /**
   * Sets an avatar into heightened attention mode
   */
  setHeightenedAttention(avatarId, channelId) {
    this.heightenedAttention.set(avatarId, {
      channelId,
      expiryTime: Date.now() + this.ATTENTION_DURATION
    });
    this.logger.info(`🔔 ${avatarId} entering heightened attention mode in ${channelId}`);
  }

  /**
   * Checks if an avatar is in heightened attention mode
   */
  isInHeightenedAttention(avatarId, channelId) {
    const attention = this.heightenedAttention.get(avatarId);
    if (!attention) return false;

    if (attention.channelId !== channelId) return false;

    if (Date.now() > attention.expiryTime) {
      this.heightenedAttention.delete(avatarId);
      return false;
    }

    return true;
  }

  /**
   * Executes an executive decision based on interactions.
   * @param {Client} client - The Discord client instance.
   * @param {TextChannel} channel - The Discord text channel.
   * @param {object} avatar - The avatar object.
   * @param {string} userId - The user ID.
   */
  async executeExecutiveDecision(client, channel, avatar, userId) {
    try {
      // Get recent conversation context
      const recentMessages = await channel.messages.fetch({ limit: 10 });

      // Format conversation history
      const messages = [];
      recentMessages.reverse().forEach(msg => {
        if (msg.webhookId) {
          messages.push({ role: 'assistant', content: `${msg.author.username}: "${msg.content}"` });
        } else {
          messages.push({ role: 'user', content: `${msg.author.username}: "${msg.content}"` });
        }
      });

      // Create decision prompt
      const decisionPrompt = [
        ...messages,
        {
          role: 'user',
          content: `As ${avatar.name}, analyze the conversation and decide if you should respond.
        Return ONLY a JSON object in this format:
        {
          "decision": "YES/NO",
          "reason": "<brief explanation why>"
        }
        
        Consider:
        1. Has someone addressed you directly?
        2. Is the topic relevant to your interests/expertise?
        3. Would your response add value?
        4. Is there a natural opening to contribute?
        5. Have you spoken too recently?`
        }
      ];

      // Get AI decision
      const response = await this.aiService.chat(decisionPrompt);
      const decision = JSON.parse(extractJSON(response));

      // Log decision
      this.logger.info(`Executive decision for ${avatar.name}: ${decision.decision} - ${decision.reason}`);

      return {
        shouldRespond: decision.decision === 'YES',
        reason: decision.reason
      };

    } catch (error) {
      this.logger.error(`Error in executive decision for ${avatar.name}: ${error.message}`);
      return {
        shouldRespond: false,
        reason: 'Error in decision making process'
      };
    }
  }

  /**
   * Get the last user who interacted with an avatar
   */
  getLastInteraction(avatarId) {
    const interaction = this.lastUserInteraction.get(avatarId);
    if (!interaction) return null;

    // Clear expired interactions
    if (Date.now() - interaction.timestamp > this.ATTENTION_DURATION) {
      this.lastUserInteraction.delete(avatarId);
      return null;
    }

    return interaction;
  }

  /**
   * Update the last user interaction for an avatar
   */
  updateLastInteraction(avatarId, userId) {
    this.lastUserInteraction.set(avatarId, {
      userId,
      timestamp: Date.now()
    });
  }
}
