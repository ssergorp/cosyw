// index.js

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import dotenv from 'dotenv';
import winston from 'winston';
import { MongoClient } from 'mongodb';
// import { OllamaService as AIService } from './services/ollamaService.mjs';
import { OpenRouterService as AIService } from './services/openrouterService.mjs';
import { AvatarGenerationService } from './services/avatarService.mjs';
import {
  reactToMessage,
  replyToMessage,
  sendAsWebhook,
  getRecentMessages,
  sendLongMessage,
  sendToThread,
} from './services/discordService.mjs';
import { ChatService } from './services/chat/ChatService.mjs'; // Updated import path

// Load environment variables from .env file
dotenv.config();

const aiService = new AIService();

// Initialize Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'application.log' }),
  ],
});

// Instantiate the Discord client with necessary permissions
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Environment Variables
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'discord-bot';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

// Validate Environment Variables
if (!BOT_TOKEN) {
  logger.error('DISCORD_BOT_TOKEN is not defined in the environment variables.');
  process.exit(1);
}

if (!MONGO_URI) {
  logger.error('MONGODB_URI is not defined in the environment variables.');
  process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
  logger.warn('DISCORD_CLIENT_ID is not defined. Slash commands registration might fail.');
}

// MongoDB client and collection
const mongoClient = new MongoClient(MONGO_URI);
let messagesCollection;

// Instantiate AvatarGenerationService
const avatarService = new AvatarGenerationService();

/**
 * Connects to MongoDB and initializes necessary collections.
 */
async function connectToDatabase() {
  const maxRetries = 3;
  const retryDelay = 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mongoClient.connect();
      const db = mongoClient.db(MONGO_DB_NAME);
      messagesCollection = db.collection('messages');
      await avatarService.connectToDatabase(db);
      logger.info('🗄️ Connected to MongoDB');
      return true;
    } catch (error) {
      logger.error(`Database connection attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

/**
 * Saves a message to the database.
 * @param {Message} message - The Discord message object.
 */
async function saveMessageToDatabase(message) {
  try {
    await messagesCollection.insertOne({
      messageId: message.id,
      channelId: message.channel.id,
      authorId: message.author.id,
      authorUsername: message.author.username,
      content: message.content,
      timestamp: message.createdTimestamp,
    });
    logger.info('💾 Message saved to database');
  } catch (error) {
    logger.error(`Failed to save message to database: ${error.message}`);
  }
}

/**
 * Handles the !summon command to create a new avatar.
 * @param {Message} message - The Discord message object.
 * @param {Array} args - The arguments provided with the command.
 */
async function handleCreateCommand(message, args) {

  await reactToMessage(client, message.channel.id, message.id, '👍');
  const prompt = args.join(' ') || 'create a new avatar, use your imagination!';

  try {
    const avatarData = {
      prompt: sanitizeInput(prompt),
      channelId: message.channel.id,
    };

    const createdAvatar = await avatarService.createAvatar(avatarData);
    createdAvatar.id = createdAvatar.id || createdAvatar._id.toString();

    if (createdAvatar && createdAvatar.id && createdAvatar.name) {
      // React to the original message with the avatar's emoji
      await reactToMessage(client, message.channel.id, message.id, createdAvatar.emoji || '🎉');

      // Construct reply content
      const replyContent = `✅ **Avatar "${createdAvatar.name}"** created successfully! 🎉\n**Traits:** ${createdAvatar.personality}\n**Description:** ${createdAvatar.description}\n**Image:** ${createdAvatar.imageUrl}`;
      await replyToMessage(client, message.channel.id, message.id, replyContent);

      let intro = await aiService.chat([
        { role: 'system', content: `
          You are the  avatar ${createdAvatar.name}.
          ${createdAvatar.description}
          ${createdAvatar.personality}
        ` },
        { role: 'user', content: `What's your avatar name? And what makes you unique in the digital realm?` }
      ]);

      createdAvatar.dynamicPersonality = intro;
      await avatarService.updateAvatar(createdAvatar);

      await sendAsWebhook(
        client,
        message.channel.id,
        intro,
        createdAvatar.name,
        createdAvatar.imageUrl
      );

    } else {
      throw new Error('Avatar missing required fields after creation:', JSON.stringify(createdAvatar, null, 2));
    }
  } catch (error) {
    logger.error(`Error creating avatar: ${error.message}`);
    await reactToMessage(client, message.channel.id, message.id, '❌');
  }
}

/**
 * Sanitizes user input to prevent injection attacks or malformed data.
 * @param {string} input - The user-provided input.
 * @returns {string} - The sanitized input.
 */
function sanitizeInput(input) {
  // Remove all characters except letters, numbers, whitespace, and emojis
  // \p{Emoji} matches any emoji character
  return input.replace(/[^\p{L}\p{N}\s\p{Emoji}]/gu, '').trim();
}

/**
 * Extracts avatars mentioned in the message content.
 * @param {string} content - The message content.
 * @param {Array} avatars - Array of all avatars.
 * @returns {Set} Set of mentioned avatars.
 */
function extractMentionedAvatars(content, avatars) {
  const mentionedAvatars = new Set();
  if (!content || !Array.isArray(avatars)) {
    logger.warn('Invalid input to extractMentionedAvatars', { content, avatarsLength: avatars?.length });
    return mentionedAvatars;
  }

  for (const avatar of avatars) {
    try {
      // Validate avatar object
      if (!avatar || typeof avatar !== 'object') {
        logger.error('Invalid avatar object:', avatar);
        continue;
      }

      // Ensure required fields exist
      if (!avatar.id || !avatar.name) {
        logger.error('Avatar missing required fields:', {
          id: avatar.id,
          name: avatar.name,
          objectKeys: Object.keys(avatar)
        });
        continue;
      }

      // Check for mentions
      const nameMatch = avatar.name && content.toLowerCase().includes(avatar.name.toLowerCase());
      const emojiMatch = avatar.emoji && content.includes(avatar.emoji);

      if (nameMatch || emojiMatch) {
        logger.info(`Found mention of avatar: ${avatar.name} (${avatar.id})`);
        mentionedAvatars.add(avatar);
      }
    } catch (error) {
      logger.error(`Error processing avatar in extractMentionedAvatars:`, {
        error: error.message,
        avatar: JSON.stringify(avatar, null, 2)
      });
    }
  }

  return mentionedAvatars;
}

/**
 * Handles other commands based on the message content.
 * @param {Message} message - The Discord message object.
 */
async function handleCommands(message, args) {

  if (message.content === '!react') {
    await reactToMessage(client, message.channel.id, message.id, '👍');
  }

  if (message.content === '!reply') {
    await replyToMessage(client, message.channel.id, message.id, 'This is a reply!');
  }

  if (message.content === '!webhook') {
    await sendAsWebhook(
      client,
      message.channel.id,
      'Hello from the webhook!',
      'Custom Bot',
      'https://d7xbminy5txaa.cloudfront.net/images/72db3459c19343c69c5ecf895983dbdbd22ad9f1504f2403074014cdf9bf15e1.png'
    );
  }

  if (message.content === '!recent') {
    const messages = await getRecentMessages(client, message.channel.id);
    if (messages && messages.length > 0) {
      const recentMessages = messages
        .map((msg) => `${msg.author.username}: ${msg.content}`)
        .join('\n');
      await sendLongMessage(client, message.channel.id, recentMessages);
    } else {
      await replyToMessage(
        client,
        message.channel.id,
        message.id,
        'No recent messages found.'
      );
    }
  }

  if (message.content.startsWith('!long ')) {
    const content = message.content.slice(6);
    await sendLongMessage(client, message.channel.id, content);
  }

  if (message.content.startsWith('!thread ')) {
    const [threadId, ...contentParts] = message.content.slice(8).split(' ');
    const content = contentParts.join(' ');
    await sendToThread(client, threadId, content);
  }

  if (message.content.startsWith('!summon ')) {
    const args = message.content.slice(8).split(' ');
    await reactToMessage(client, message.channel.id, message.id, '🔮');
    await handleCreateCommand(message, args);
    await reactToMessage(client, message.channel.id, message.id, '✅');
  }
} // Added closing brace for handleOtherCommands

client.on('messageCreate', async (message) => {
  try {

    
    // Only process commands for non-bot messages
    if (message.content.startsWith('!')) {
      const [command, ...args] = message.content.slice(1).split(' ');
      await handleCommands(message, args);
    }

    // Ensure chatService exists before calling methods
    if (chatService && typeof chatService.updateLastMessageTime === 'function') {
      chatService.updateLastMessageTime();
    }

    // Save all messages to database
      await saveMessageToDatabase(message);
    
    // Track message for attention decay
    if (chatService) {
      chatService.markChannelActivity(message.channel.id);
    }

    // Get all avatars and check for mentions
    const avatars = await avatarService.getAllAvatars();
    logger.info(`Retrieved ${avatars?.length || 0} avatars from database`);
    
    if (!avatars?.length) {
      logger.warn('No avatars available');
      return;
    }

    const mentionedAvatars = extractMentionedAvatars(message.content, avatars);

    logger.info(`Message received: "${message.content}" - Mentioned avatars: ${Array.from(mentionedAvatars).map(a => a.name).join(', ')}`);

    // Validate channel ID before proceeding
    if (!message.channel || !message.channel.id) {
      logger.error('Message does not have a valid channel ID:', message);
      return;
    }

    // Handle mentions
    if (mentionedAvatars.size > 0) {
      for (const avatar of mentionedAvatars) {
        const avatarId = avatar.id || avatar._id.toString();
        if (!avatarId) {
          logger.error('Invalid avatar data:', JSON.stringify(avatar, null, 2));
          continue;
        }
        logger.info(`Processing mention for avatar: ${avatar.name} (ID: ${avatarId})`);
        chatService.handleMention(message.channel.id, avatarId);
        await chatService.respondAsAvatar(client, message.channel, avatar, !message.author.bot);
      }
    } else {
      // Check for recently mentioned avatars that might want to respond
      const avatarsInChannel = chatService.avatarTracker.getAvatarsInChannel(message.channel.id);
      for (const avatarId of avatarsInChannel) {
        const avatar = avatars.find(a => a.id === avatarId);
        if (avatar) {
          await chatService.respondAsAvatar(client, message.channel, avatar, false);
        }
      }
    }

  } catch (error) {
    logger.error(`Error processing message: ${error.stack}`);
  }
});

/**
 * Gracefully shuts down the application on termination signals.
 * @param {string} signal - The signal received (e.g., SIGINT, SIGTERM).
 */
async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  const shutdownPromises = [
    (async () => {
      try {
        await client.destroy();
        logger.info('Disconnected from Discord.');
      } catch (error) {
        logger.error(`Error disconnecting from Discord: ${error.message}`);
      }
    })(),
    (async () => {
      try {
        await mongoClient.close(true);
        logger.info('Closed MongoDB connection.');
      } catch (error) {
        logger.error(`Error closing MongoDB connection: ${error.message}`);
      }
    })(),
    (async () => {
      if (chatService) {
        try {
          await chatService.stop();
          logger.info('ChatService stopped.');
        } catch (error) {
          logger.error(`Error stopping ChatService: ${error.message}`);
        }
      }
    })()
  ];

  await Promise.allSettled(shutdownPromises);
  process.exit(0);
}

// Handle termination signals
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Instantiate ChatService (declare here for shutdown handling)
let chatService;

// Fix the IIFE syntax and add error handling
(async function main() {
  try {
    // Connect to database first
    await connectToDatabase();
    logger.info('✅ Database connection established');

    // Initialize chat service
    chatService = new ChatService(client, mongoClient, {
      logger,
      avatarService,
      aiService,
    });

    // Login to Discord
    await client.login(BOT_TOKEN);
    logger.info('✅ Logged into Discord successfully');

    // Wait for client to be ready
    await new Promise(resolve => client.once('ready', resolve));
    logger.info('✅ Discord client ready');

    // Setup and start chat service
    await chatService.setupWithRetry();
    await chatService.start();
    logger.info('✅ Chat service started successfully');

  } catch (error) {
    logger.error(`Fatal startup error: ${error.stack || error.message}`);
    await shutdown('STARTUP_ERROR');
  }
})().catch(error => {
  console.error('Unhandled startup error:', error);
  process.exit(1);
});
