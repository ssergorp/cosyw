// discordService.js

import { Client, GatewayIntentBits, Partials, WebhookClient } from 'discord.js';
import winston from 'winston';

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
    new winston.transports.File({ filename: 'discordService.log' }),
  ],
});

// Webhook management cache
const webhookCache = new Map();

/**
 * Reacts to a message with a specified emoji.
 * @param {Client} client - The Discord client instance.
 * @param {string} channelId - The ID of the channel containing the message.
 * @param {string} messageId - The ID of the message to react to.
 * @param {string} emoji - The emoji to react with.
 */
export async function reactToMessage(client, channelId, messageId, emoji) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel with ID ${channelId} not found.`);
    const message = await channel.messages.fetch(messageId);
    if (!message) throw new Error(`Message with ID ${messageId} not found.`);
    await message.react(emoji);
    logger.info(`Reacted to message ${messageId} in channel ${channelId} with ${emoji}`);
  } catch (error) {
    logger.error(`Failed to react to message ${messageId} in channel ${channelId}: ${error.message}`);
  }
}

/**
 * Replies to a specific message.
 * @param {Client} client - The Discord client instance.
 * @param {string} channelId - The ID of the channel containing the message.
 * @param {string} messageId - The ID of the message to reply to.
 * @param {string} replyContent - The content of the reply.
 */
export async function replyToMessage(client, channelId, messageId, replyContent) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel with ID ${channelId} not found.`);
    const message = await channel.messages.fetch(messageId);
    if (!message) throw new Error(`Message with ID ${messageId} not found.`);
    await message.reply(replyContent);
    logger.info(`Replied to message ${messageId} in channel ${channelId} with: ${replyContent}`);
  } catch (error) {
    logger.error(`Failed to reply to message ${messageId} in channel ${channelId}: ${error.message}`);
  }
}

/**
 * Creates or fetches a webhook for a given channel.
 * @param {Client} client - The Discord client instance.
 * @param {Channel} channel - The Discord channel object.
 * @returns {WebhookClient|null} - The webhook client or null if failed.
 */
async function getOrCreateWebhook(client, channel) {
  try {

    if (channel.isThread()) {
      channel = await channel.parent.fetch();
    }


    if (webhookCache.has(channel.id)) {
      return webhookCache.get(channel.id);
    }

    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find((wh) => wh.owner.id === client.user.id);

    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'Multi-Avatar Bot Webhook',
        avatar: client.user.displayAvatarURL(),
      });
      logger.info(`Created new webhook for channel ${channel.id}`);
    }

    webhookCache.set(channel.id, webhook);
    return webhook;
  } catch (error) {
    logger.error(`Failed to create or fetch webhook for channel ${channel.id}: ${error.message}`);
    return null;
  }
}

/**
 * Sends a message via webhook with a custom username and avatar.
 * @param {Client} client - The Discord client instance.
 * @param {string} channelId - The ID of the channel to send the message in.
 * @param {string} content - The content of the message.
 * @param {string} username - The username to display for the webhook message.
 * @param {string} avatarUrl - The URL of the avatar to display for the webhook message.
 */
export async function sendAsWebhook(client, channelId, content, username, avatarUrl) {
  if (!channelId || typeof channelId !== 'string') {
    throw new Error(`Invalid channel ID: ${channelId}`);
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    // Get parent channel if this is a thread
    const targetChannel = channel.isThread() ? channel.parent : channel;

    if (!targetChannel) {
      throw new Error(`Parent channel not found for thread ${channelId}`);
    }

    let webhook = await getOrCreateWebhook(client, targetChannel);

    const chunks = chunkMessage(content);
    for (const chunk of chunks) {
        // Send to thread if needed, otherwise send to channel
        await webhook.send({
          content: chunk,
          username: username.slice(0, 80),
          avatarURL: avatarUrl,
          threadId: channel.isThread() ? channelId : undefined
        });
        logger.info(`Sent message to channel ${channelId} via webhook`);
     }

  } catch (error) {
    console.error(`Webhook error for channel ${channelId}: ${error.message}`);
    throw error;
  }
}

/**
 * Fetches recent messages from a channel.
 * @param {Client} client - The Discord client instance.
 * @param {string} channelId - The ID of the channel to fetch messages from.
 * @param {number} limit - The number of messages to fetch.
 * @returns {Array} - An array of message objects.
 */
export async function getRecentMessages(client, channelId, limit = 10) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel with ID ${channelId} not found.`);
    const messages = await channel.messages.fetch({ limit });
    logger.info(`Fetched ${messages.size} recent messages from channel ${channelId}`);
    return Array.from(messages.values());
  } catch (error) {
    logger.error(`Failed to fetch recent messages from channel ${channelId}: ${error.message}`);
    return [];
  }
}

export function chunkMessage(message, chunkSize = 2000) {
  if (!message) return [];
  // Split the message into paragraphs based on double line breaks
  const paragraphs = message.split(/\n\s*\n/);
  const chunks = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();

    // Check if adding the paragraph exceeds the chunk size
    if ((currentChunk + '\n\n' + trimmedParagraph).length <= chunkSize) {
      if (currentChunk) {
        currentChunk += '\n\n' + trimmedParagraph;
      } else {
        currentChunk = trimmedParagraph;
      }
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      // If the paragraph itself is larger than chunkSize, split it further
      if (trimmedParagraph.length <= chunkSize) {
        currentChunk = trimmedParagraph;
      } else {
        // Split the large paragraph into lines
        const lines = trimmedParagraph.split('\n');
        currentChunk = '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if ((currentChunk + '\n' + trimmedLine).length <= chunkSize) {
            if (currentChunk) {
              currentChunk += '\n' + trimmedLine;
            } else {
              currentChunk = trimmedLine;
            }
          } else {
            if (currentChunk) {
              chunks.push(currentChunk);
            }
            // If the line is still too big, split it into smaller chunks
            if (trimmedLine.length <= chunkSize) {
              currentChunk = trimmedLine;
            } else {
              const splitLine = trimmedLine.match(new RegExp(`.{1,${chunkSize}}`, 'g'));
              chunks.push(...splitLine.slice(0, -1));
              currentChunk = splitLine[splitLine.length - 1];
            }
          }
        }
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}


/**
 * Sends a long message by chunking it if necessary.
 * @param {Client} client - The Discord client instance.
 * @param {string} channelId - The ID of the channel to send the message in.
 * @param {string} content - The content of the message.
 */
export async function sendLongMessage(client, channelId, content) {
  try {
    const chunks = chunkMessage(content);
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel with ID ${channelId} not found.`);

    for (const chunk of chunks) {
      await channel.send(chunk);
    }

    logger.info(`Sent long message to channel ${channelId}`);
  } catch (error) {
    logger.error(`Failed to send long message to channel ${channelId}: ${error.message}`);
  }
}

/**
 * Sends a message to a specific thread.
 * @param {Client} client - The Discord client instance.
 * @param {string} threadId - The ID of the thread to send the message in.
 * @param {string} content - The content of the message.
 */
export async function sendToThread(client, threadId, content) {
  try {
    const thread = await client.channels.fetch(threadId);
    if (!thread || !thread.isThread()) {
      throw new Error(`Thread with ID ${threadId} not found or is not a thread.`);
    }

    const channel = thread.parent;
    if (!channel) throw new Error(`Parent channel for thread ${threadId} not found.`);

    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find((wh) => wh.owner.id === client.user.id);

    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'Multi-Avatar Bot Webhook',
        avatar: client.user.displayAvatarURL(),
      });
      logger.info(`Created new webhook for parent channel ${channel.id}`);
    }

    const chunks = chunkMessage(content);
    for (const chunk of chunks) {
      await webhook.send({
        content: chunk,
        threadId: thread.id,
      });
    }

    logger.info(`Sent message to thread ${thread.id}`);
  } catch (error) {
    logger.error(`Failed to send message to thread ${threadId}: ${error.message}`);
  }
}
