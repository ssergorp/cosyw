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
} from './services/discordService.mjs';
import { ChatService } from './services/chat/ChatService.mjs'; // Updated import path
import { MessageHandler } from './services/chat/MessageHandler.mjs';

// Load environment variables from .env file
dotenv.config();

const aiService = new AIService();

// Initialize Logger
const logger = winston.createLogger({
  level: 'warn',
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
 * Saves a message to the database.
 * @param {Message} message - The Discord message object.
 */
async function saveMessageToDatabase(message) {
  if (!messagesCollection) {
    logger.error('Messages collection not initialized');
    return;
  }

  try {
    const messageData = {
      messageId: message.id,
      channelId: message.channel.id,
      authorId: message.author.id,
      authorUsername: message.author.username,
      content: message.content,
      timestamp: message.createdTimestamp,
    };

    // Validate required fields
    if (!messageData.messageId || !messageData.channelId) {
      logger.error('Missing required message data:', messageData);
      return;
    }

    await messagesCollection.insertOne(messageData);
    logger.info('💾 Message saved to database');
  } catch (error) {
    logger.error(`Failed to save message to database: ${error.message}`);
  }
}

async function handleBreedCommand(message, args) {
  // find an avatar for each argument
  const avatars = await avatarService.getAllAvatars();
  const mentionedAvatars = extractMentionedAvatars(message.content, avatars);

  // if there are two avatars mentioned, reply with their names
  if (mentionedAvatars.size === 2) {
    const [avatar1, avatar2] = Array.from(mentionedAvatars);
    await replyToMessage(
      client,
      message.channel.id,
      message.id,
      `Breeding ${avatar1.name} with ${avatar2.name}...`
    );


    // combine the prompt, dynamicPersonality, and description of the two avatars into a message for createAvatar
    const prompt = `Breed the following avatars, and create a new avatar:
      AVATAR 1: ${avatar1.name} - ${avatar1.prompt}
      ${avatar1.description}
      ${avatar1.dynamicPersonality}

      AVATAR 2: ${avatar2.name} - ${avatar2.prompt}
      ${avatar2.description}
      ${avatar2.dynamicPersonality}
      `;

    return await handleCreateCommand(message, [prompt]);
  } else {
    await replyToMessage(
      client,
      message.channel.id,
      message.id,
      'Please mention two avatars to breed.'
    );
  }
}

/**
 * Handles the !attack command to attack another avatar.
 */
async function handleAttackCommand(message, args) {
  if (args.length < 1) {
    await replyToMessage(
      client,
      message.channel.id,
      message.id,
      'Please mention an avatar to attack.'
    );
    return;
  }

  const targetName = args.join(' ');
  const avatars = await avatarService.getAllAvatars();
  const targetAvatar = await findAvatarByName(targetName, avatars);

  if (!targetAvatar) {
    await replyToMessage(
      client,
      message.channel.id,
      message.id,
      `Could not find an avatar named "${targetName}".`
    );
    return;
  }

  const attackResult = await chatService.dungeonService.tools.get('attack').execute(message, [targetAvatar.name]);

  await replyToMessage(
    client,
    message.channel.id,
    message.id,
    `🔥 **${attackResult}**`
  );
}

/**
 * Handles the !summon command to create a new avatar.
 * @param {Message} message - The Discord message object.
 * @param {Array} args - The arguments provided with the command.
 */
async function handleCreateCommand(message, args) {
  let prompt = args.join(' ');
  let existingAvatar = null; // Declare at the start

  try {
    // First check if this might be summoning an existing avatar
    const avatars = await avatarService.getAllAvatars();
    existingAvatar = await findAvatarByName(prompt, avatars);

    // Update the summon existing avatar logic
    if (existingAvatar) {
      const avatarId = existingAvatar.id || existingAvatar._id?.toString();
      if (!avatarId) {
        throw new Error('Avatar has no valid ID');
      }

      await reactToMessage(client, message.channel.id, message.id, existingAvatar.emoji || '🔮');


      // Update database position
      await chatService.dungeonService.updateAvatarPosition(avatarId, message.channel.id);

      existingAvatar.channelId = message.channel.id;
      await avatarService.updateAvatar(existingAvatar);

      // Send a message to the channel
      const intro = `🔮 **${existingAvatar.name}** appears!
          
          ${existingAvatar.description}
          
          ${existingAvatar.imageUrl}`
      await sendAsWebhook(
        client,
        message.channel.id,
        intro,
        existingAvatar.name,
        existingAvatar.imageUrl
      );
      return;
    }

    // If no existing avatar found, proceed with creating new one
    // If no prompt provided, check for default Arweave prompt URL in env
    if (!prompt && process.env.DEFAULT_AVATAR_PROMPT_URL) {
      prompt = process.env.DEFAULT_AVATAR_PROMPT_URL;
    } else if (!prompt) {
      prompt = 'create a new avatar, use your imagination!';
    }

    const avatarData = {
      prompt: sanitizeInput(prompt),
      channelId: message.channel.id,
    };

    // Check if prompt is an Arweave URL
    if (prompt.match(/^(https:\/\/.*\.arweave\.net\/|ar:\/\/)/)) {
      avatarData.arweave_prompt = prompt;
    }

    const createdAvatar = await avatarService.createAvatar(avatarData);
    createdAvatar.id = createdAvatar.id || createdAvatar._id.toString();

    if (createdAvatar && createdAvatar.id && createdAvatar.name) {
      // React to the original message with the avatar's emoji
      await reactToMessage(client, message.channel.id, message.id, createdAvatar.emoji || '🎉');

      // Construct reply content
      const replyContent = `✅ **Avatar "${createdAvatar.name}"** created successfully! 🎉\n**Traits:** ${createdAvatar.personality}\n**Description:** ${createdAvatar.description}\n**Image:** ${createdAvatar.imageUrl}`;
      await replyToMessage(client, message.channel.id, message.id, replyContent);

      if (!createdAvatar.model) {
        createdAvatar.model = await aiService.selectRandomModel();
      }

      let intro = await aiService.chat([
        {
          role: 'system', content: `
          You are the  avatar ${createdAvatar.name}.
          ${createdAvatar.description}
          ${createdAvatar.personality}
        ` },
        { role: 'user', content: `What's your avatar name? And what makes you unique in the digital realm?` }
      ], { model: createdAvatar.model });

      createdAvatar.dynamicPersonality = intro;
      createdAvatar.channeId = message.channel.id;
      await avatarService.updateAvatar(createdAvatar);

      await sendAsWebhook(
        client,
        message.channel.id,
        intro,
        createdAvatar.name,
        createdAvatar.imageUrl
      );

      // Initialize avatar position in current channel instead of market
      await chatService.dungeonService.initializeAvatar(
        createdAvatar.id, message.channel.id
      );

    } else {
      throw new Error('Avatar missing required fields after creation:', JSON.stringify(createdAvatar, null, 2));
    }
  } catch (error) {
    logger.error(`Error in summon command: ${error.message}`);
    if (existingAvatar) {
      logger.debug('Avatar data:', JSON.stringify(existingAvatar, null, 2));
    }
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

// Add this new function after sanitizeInput
async function findAvatarByName(name, avatars) {
  const sanitizedName = sanitizeInput(name.toLowerCase());
  return avatars.find(avatar =>
    avatar.name.toLowerCase() === sanitizedName ||
    sanitizeInput(avatar.name.toLowerCase()) === sanitizedName
  );
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

  if (message.content.toLowerCase().startsWith('!summon ')) {
    const args = message.content.slice(8).split(' ');
    await reactToMessage(client, message.channel.id, message.id, '🔮');
    await handleCreateCommand(message, args);
    await reactToMessage(client, message.channel.id, message.id, '✅');
  }

  if (message.content.toLowerCase().startsWith('!attack ')) {
    const args = message.content.slice(8).split(' ');
    await reactToMessage(client, message.channel.id, message.id, '⚔️');
    await handleAttackCommand(message, args);
    await reactToMessage(client, message.channel.id, message.id, '✅');
  }

  if (message.content.startsWith('!breed')) {
    const args = message.content.slice(6).split(' ');
    await reactToMessage(client, message.channel.id, message.id, '🔮');
    await handleBreedCommand(message, args);
    await reactToMessage(client, message.channel.id, message.id, '✅');
  }
}

client.on('messageCreate', async (message) => {
  try {
    if (!messageHandler) {
      logger.error('MessageHandler not initialized');
      return;
    }

    // Handle commands first
    if (message.content.startsWith('!')) {
      const [command, ...args] = message.content.slice(1).split(' ');
      await handleCommands(message, args);
      return;
    }

    // Save message to database
    await saveMessageToDatabase(message);

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
let messageHandler;

// Fix the IIFE syntax and add error handling
async function main() {
  let dbConnected = false;
  try {
    // Connect to database first
    await mongoClient.connect();
    dbConnected = true;
    const db = mongoClient.db(MONGO_DB_NAME);
    messagesCollection = db.collection('messages');

    // Initialize avatar service
    await avatarService.connectToDatabase(db);


    dbConnected = true;
    logger.info('✅ Connected to database successfully');

    // Update all Arweave prompts
    logger.info('Updating Arweave prompts for avatars...');
    await avatarService.updateAllArweavePrompts();
    logger.info('✅ Arweave prompts updated successfully');

    // Initialize chat service with all required dependencies
    chatService = new ChatService(client, db, {
      logger,
      avatarService,
      aiService,
    });

    // Initialize message handler
    messageHandler = new MessageHandler(chatService, avatarService, logger);

    // Login to Discord before starting services
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
    if (dbConnected) {
      try {
        await mongoClient.close();
      } catch (closeError) {
        logger.error(`Error closing database: ${closeError.message}`);
      }
    }
    await shutdown('STARTUP_ERROR');
  }
}

main().catch(error => {
  console.error('Unhandled startup error:', error);
  process.exit(1);
});
