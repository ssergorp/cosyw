import { sendAsWebhook } from './discordService.mjs';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async/fixed';

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
    this.intervalTime = 30000; // 30 seconds (corrected from 5000 ms)

    // Map to track last responded channel per avatar
    this.avatarLastChannelMap = new Map();
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
   * Checks for new messages and processes them.
   */
  async checkMessages() {
    try {
      const guilds = this.client.guilds.cache;

      for (const [guildId, guild] of guilds) {
        const channels = guild.channels.cache.filter(channel => channel.isTextBased());

        for (const [channelId, channel] of channels) {
          // Fetch recent messages
          const recentMessages = await channel.messages.fetch({ limit: 50 }); // Adjust as needed

          // Collect all recent messages content in lowercase
          const recentContent = recentMessages.map(msg => msg.content.toLowerCase()).join(' ');

          const avatars = await this.avatarService.getAllAvatars(); // Assuming this method exists

          for (const avatar of avatars) {
            const avatarNameLower = avatar.name.toLowerCase();
            const avatarEmoji = avatar.emoji;

            // Check if the recent messages mention the avatar by name or emoji
            if (recentContent.includes(avatarNameLower) || recentContent.includes(avatarEmoji)) {
              const lastChannelId = this.avatarLastChannelMap.get(avatar.id);

              // If the avatar was last active in a different channel, move it to the new channel
              if (lastChannelId && lastChannelId !== channelId) {
                this.logger.info(`🔄 Moving avatar "${avatar.name}" from channel ${lastChannelId} to channel ${channelId}`);
                // Optionally, you can send a message to the previous channel indicating the move
                const previousChannel = await this.client.channels.fetch(lastChannelId);
                if (previousChannel && previousChannel.isTextBased()) {
                  await sendAsWebhook(
                    previousChannel,
                    avatar,
                    `I'm moving to <#${channelId}> to assist you there!`
                  );
                }
              }

              // Respond as the avatar in the current channel
              await this.respondAsAvatar(this.client, channel, avatar);

              // Update the last channel map
              this.avatarLastChannelMap.set(avatar.id, channelId);

              this.logger.info(`🤖 Responded as ${avatar.name} in channel ${channel.id}`);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`📛 Error in checkMessages: ${error.message}`);
    }
  }

  /**
   * Sends a message as the specified avatar with an inner monologue.
   * @param {TextChannel} channel - The Discord text channel.
   * @param {object} avatar - The avatar's name in lowercase.
   */
  async respondAsAvatar(client, channel, avatar) {
    try {
      // Define how many recent messages to fetch
      const MESSAGE_LIMIT = 10;

      const prior_systemPrompt = `You are ${avatar.name} ${avatar.emoji}.
        ${avatar.description || 'Describe yourself in a few words.'}
        ${avatar.dynamicPersonality || 'Introduce yourself as if designing a system prompt for yourself.'}
      `;
``
      let intro;
      if (!avatar.dynamicPersonality || avatar.timestamp < Date.now() - 1000 * 60 * 60 * 24) {
        console.log('Updating dynamic personality');
        intro = await this.aiService.chat('llama3.2', [
          { role: 'system', content: prior_systemPrompt },
          { role: 'user', content: `You wake up from a dream, describe your process of waking up and remembering who you are.` }
        ]);

        avatar.dynamicPersonality = intro;
        await this.avatarService.updateAvatar(avatar);
      }

      const systemPrompt = `You are ${avatar.name} ${avatar.emoji}.
        
        ${avatar.description}
        
        ${avatar.dynamicPersonality || ''}
      `;

      console.log(systemPrompt);

      // Fetch recent messages from the channel
      const fetchedMessages = await channel.messages.fetch({ limit: MESSAGE_LIMIT });

      // Initialize the messages array with the system prompt
      const messages = [
        { role: 'system', content: `You are ${avatar.name} ${avatar.emoji}. Always respond with SHORT messages no more than one or two sentences and *actions*.` }
      ];

      // Process each fetched message
      fetchedMessages
        .reverse() // Ensure chronological order
        .forEach(msg => {
          if (msg.author.username.toLowerCase() === avatar.name.toLowerCase()) {
            // Messages from the avatar are treated as 'assistant'
            messages.push({ role: 'assistant', content: msg.content });
          } else {
            // Messages from others are treated as 'user' with formatted content
            messages.push({ role: 'user', content: `${msg.author.username} said: "${msg.content}"` });
          }
        });

      messages.push({ role: 'user', content: `Please respond to the above conversation briefly.` });

      // Generate the avatar's response using AiService
      const avatarResponse = await this.aiService.chat(messages);

      // Send the generated response as a webhook with the avatar's name and image
      await sendAsWebhook(client, channel.id, avatarResponse, avatar.name, avatar.imageUrl);
    } catch (error) {
      this.logger.error(`📛 Error in respondAsAvatar: ${error.message}`);
      throw error;
    }
  }
}
