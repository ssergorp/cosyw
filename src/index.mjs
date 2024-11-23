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
import { ChatService } from './services/chatService.mjs'; // Import ChatService

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
  try {
    await mongoClient.connect();
    const db = mongoClient.db(MONGO_DB_NAME);
    messagesCollection = db.collection('messages');
    await avatarService.connectToDatabase(db);
    logger.info('🗄️ Connected to MongoDB');
  } catch (error) {
    logger.error(`Failed to connect to MongoDB: ${error.message}`);
    process.exit(1);
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
 * Handles the !create command to create a new avatar.
 * @param {Message} message - The Discord message object.
 * @param {Array} args - The arguments provided with the command.
 */
async function handleCreateCommand(message, args) {

  const prompt = args.join(' ') || 'create a new avatar, use your imagination!';

  try {
    const avatarData = {
      prompt: sanitizeInput(prompt),
      channelId: message.channel.id,
    };

    // React to the original message with the avatar's emoji
    await reactToMessage(client, message.channel.id, message.id, avatarData.emoji || '🎉');

    const createdAvatar = await avatarService.createAvatar({ prompt, channelId: message.channel.id });

    if (createdAvatar) {
      // Construct reply content
      const replyContent = `✅ **Avatar "${createdAvatar.name}"** created successfully! 🎉\n**Traits:** ${createdAvatar.personality}\n**Description:** ${createdAvatar.description}\n**Image:** ${createdAvatar.imageUrl}`;
      await replyToMessage(client, message.channel.id, message.id, replyContent);

      let intro = await aiService.chat('llama3.2', [
        { role: 'system', content: `You are ${createdAvatar.name}.` },
        { role: 'user', content: `Introduce yourself as if designing a system prompt for yourself.` }
      ]);

      createdAvatar.dynamicPersonality = intro;
      avatarService.updateAvatar(createdAvatar);

      await sendAsWebhook(
        client,
        message.channel.id,
        intro,
        createdAvatar.name,
        createdAvatar.imageUrl
      );

    } else {
      await replyToMessage(
        client,
        message.channel.id,
        message.id,
        '❌ Failed to create avatar. Please ensure all fields are correct and try again.'
      );
    }
  } catch (error) {
    logger.error(`Error creating avatar: ${error.message}`);
    await replyToMessage(
      client,
      message.channel.id,
      message.id,
      '❌ An error occurred while creating the avatar. Please try again later.'
    );
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
 * Handles other commands based on the message content.
 * @param {Message} message - The Discord message object.
 */
async function handleOtherCommands(message) {
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
      'https://example.com/avatar.png'
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
}

/**
 * Processes incoming messages and handles commands.
 */
client.on('messageCreate', async (message) => {
  // Ignore messages from bots
  if (message.author.bot) return;

  // Save message to database
  await saveMessageToDatabase(message);

  // Command handling
  if (message.content.startsWith('!')) {
    const args = message.content.slice(1).split(' ');
    const command = args.shift().toLowerCase();

    switch (command) {
      case 'summon':
        await handleCreateCommand(message, args);
        break;
      default:
        await handleOtherCommands(message);
        break;
    }
  }
});

/**
 * Gracefully shuts down the application on termination signals.
 * @param {string} signal - The signal received (e.g., SIGINT, SIGTERM).
 */
async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    // Disconnect from Discord
    await client.destroy();
    logger.info('Disconnected from Discord.');

    // Close MongoDB connection
    await mongoClient.close();
    logger.info('Closed MongoDB connection.');

    // Stop ChatService
    if (chatService) {
      await chatService.stop();
    }

    process.exit(0);
  } catch (error) {
    logger.error(`Error during shutdown: ${error.message}`);
    process.exit(1);
  }
}

// Handle termination signals
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Instantiate ChatService (declare here for shutdown handling)
let chatService;

/**
 * Starts the application by connecting to the database and logging into Discord.
 */
(async () => {
  await connectToDatabase();

  // Instantiate ChatService
  chatService = new ChatService(client, mongoClient, {
    logger,
    avatarService,
    aiService,
  });

  // Start ChatService
  chatService.start();

  client.login(BOT_TOKEN).then(() => {
    logger.info('✅ Logged into Discord successfully.');
  }).catch((error) => {
    logger.error(`Failed to login to Discord: ${error.message}`);
    process.exit(1);
  });
})();
