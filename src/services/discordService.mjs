// discordService.js

import { Client, GatewayIntentBits, Partials, WebhookClient } from 'discord.js';
import winston from 'winston';

import { chunkMessage } from './utils/messageChunker.mjs';
import { processMessageLinks } from './utils/linkProcessor.mjs';

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
 * Sends an avatar profile as an embed via webhook with a custom username and avatar.
 * @param {Client} client - The Discord client instance.
 * @param {Object} avatar - The avatar object containing profile information.
 */
export async function sendAvatarProfileEmbedFromObject(client, avatar) {
  if (!avatar || typeof avatar !== 'object') {
    throw new Error('Invalid avatar object provided.');
  }

  const {
    name,
    emoji,
    description,
    imageUrl,
    channelId,
    model,
    createdAt,
    updatedAt,
    traits, // Assuming 'traits' is a string; adjust if it's an array
    innerMonologueThreadId, // Assuming this is optional
  } = avatar;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error(`Invalid channel ID: ${channelId}`);
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel not found or is not a text channel: ${channelId}`);
    }

    // Get or create webhook
    const webhook = await getOrCreateWebhook(client, channel);

    // Create the embed using EmbedBuilder
    const avatarEmbed = new EmbedBuilder()
      .setColor(0x1e90ff) // DodgerBlue; customize as needed
      .setTitle(`${emoji} ${name}`)
      .setURL(innerMonologueThreadId
        ? `https://discord.com/channels/${channel.guildId}/${channelId}/${innerMonologueThreadId}`
        : `https://discord.com/users/${channel.guildId}`) // Adjust URL as needed
      .setAuthor({
        name: `${name} ${emoji}`,
        iconURL: imageUrl,
        url: innerMonologueThreadId
          ? `https://discord.com/channels/${channel.guildId}/${channelId}/${innerMonologueThreadId}`
          : `https://discord.com/users/${channel.guildId}`, // Adjust URL as needed
      })
      .setDescription(description || 'No description found.')
      .setThumbnail(imageUrl)
      .addFields(
        {
          name: '📅 Summoning Date',
          value: `<t:${Math.floor(new Date(createdAt || Date.now()).getTime() / 1000)}:F>`,
          inline: true,
        },
        {
          name: '🧠 Model',
          value: `${model || 'N/A'}`,
          inline: true,
        },
        {
          name: '⭐ Traits',
          value: traits || 'None',
          inline: false,
        }
      )
      .setImage(imageUrl)
      .setTimestamp(new Date(updatedAt || Date.now()))
      .setFooter({
        text: `Profile of ${name}`,
        iconURL: imageUrl,
      });

    // Optionally, add a link to the inner monologue thread
    if (innerMonologueThreadId) {
      avatarEmbed.addFields({
        name: '🧵 Inner Monologue Thread',
        value: `[View Thread](https://discord.com/channels/${channel.guildId}/${channelId}/${innerMonologueThreadId})`,
        inline: false,
      });
    }

    // Send the embed via webhook
    await webhook.send({
      embeds: [avatarEmbed],
      threadId: channel.isThread() ? channelId : undefined,
      username: name.slice(0, 80), // Discord limits usernames to 80 characters
      avatarURL: imageUrl,
    });

    console.log(`Sent avatar profile for ${name} via webhook to channel ${channelId}`);
  } catch (error) {
    console.error(`Failed to send avatar profile to channel ${channelId}: ${error.message}`);
    // Optionally, log the error using your logger
    // logger.error(`Failed to send avatar profile to channel ${channelId}: ${error.message}`);
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
  let channelName = null;

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
    
    const chunks = chunkMessage(processMessageLinks(content));
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
    console.error(error.message);
    console.error(channelName, channelId);
    logger.error(`Failed to send message to channel ${channelId} via webhook: ${error.message}`);
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



