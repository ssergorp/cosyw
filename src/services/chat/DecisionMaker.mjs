import { sendAsWebhook } from "../discordService.mjs";

const DECISION_MODEL = 'meta-llama/llama-3.2-1b-instruct';

export class DecisionMaker {
  constructor(aiService, logger) {
    this.aiService = aiService;
    this.logger = logger;
    this.recentResponses = new Map(); // channelId -> Map<avatarId, timestamp>
    this.RECENT_WINDOW = 5 * 60 * 1000; // 5 minutes
    this.botMentionDebounce = new Map(); // avatarId -> timestamp
    this.BOT_MENTION_COOLDOWN = 30000; // 30 seconds
  }

  trackResponse(channelId, avatarId) {
    if (!this.recentResponses.has(channelId)) {
      this.recentResponses.set(channelId, new Map());
    }
    this.recentResponses.get(channelId).set(avatarId, Date.now());
  }

  getRecentlyActiveAvatars(channelId) {
    const recent = this.recentResponses.get(channelId);
    if (!recent) return [];

    const now = Date.now();
    const activeAvatars = [];

    for (const [avatarId, timestamp] of recent) {
      if (now - timestamp < this.RECENT_WINDOW) {
        activeAvatars.push(avatarId);
      }
    }

    return activeAvatars;
  }

  async shouldRespond(channel, avatar, client) {
    // Validate channel and avatar
    if (!channel || !channel.id || typeof channel.id !== 'string') {
      this.logger.error('Invalid channel provided to shouldRespond:', channel);
      return false;
    }

    // get the latest few messages in the channel
    const channelMessages = await channel.messages.fetch({ limit: 8 });
    // calculate the percentage of messages that are from .bot
    const botMessageCount = channelMessages.filter(m => m.author.bot).size;
    const botMessagePercentage = botMessageCount / channelMessages.size;

    const lastMessage = channelMessages.first();

    // if the author username is the same as the avatar name, don't respond
    if (lastMessage.author.username.toLowerCase() === avatar.name.toLowerCase()) {
      return false;
    }
    const isAvatarMentioned = lastMessage.content.toLowerCase().includes(avatar.name.toLowerCase()) ||
      (avatar.emoji && lastMessage.content.includes(avatar.emoji));
    if (isAvatarMentioned) {
      return !lastMessage.author.bot || Math.random() > botMessagePercentage;
    }

    const avatarId = avatar._id || avatar._id;

    if (!avatarId || !avatar.name) {
      this.logger.error('DecisionMaker received avatar with missing id or name:', JSON.stringify(avatar, null, 2));
      return false;
    }

    try {
      // Get recent messages for context
      const messages = await channel.messages.fetch({ limit: 5 });
      const latestMessage = messages.first();
      if (!latestMessage) {
        return false;
      }
      if (latestMessage.author.bot && latestMessage.author.username.toLowerCase() === avatar.name.toLowerCase()) {
        return false;
      }
      const context = messages.reverse().map(m => ({
        role: m.author.bot ? 'assistant' : 'user',
        content: `${m.author.username}: ${m.content}`
      }));

      if (!avatar.innerMonologueChannel) {
        // Find #avatars channel
        const avatarsChannel = channel.guild.channels.cache.find(c => c.name === 'avatars');
        if (avatarsChannel) {
          // Find a thread called avatar.name Narratives
          const innerMonologueChannel = avatarsChannel.threads.cache.find(t => t.name === `${avatar.name} Narratives`);
          if (innerMonologueChannel) {
            avatar.innerMonologueChannel = innerMonologueChannel.id;
          }
          // Otherwise create a new thread
          else {
            const newThread = await avatarsChannel.threads.create({
              name: `${avatar.name} Narratives`,
              autoArchiveDuration: 60,
              reason: 'Create inner monologue thread for avatar'
            });
            avatar.innerMonologueChannel = newThread.id;

            // Post the avatars image to the inner monologue channel
            sendAsWebhook(
              avatar.innerMonologueChannel,
              avatar.imageUrl,
              avatar.name, avatar.imageUrl
            );

            // Post the avatars description to the inner monologue channel
            sendAsWebhook(
              avatar.innerMonologueChannel,
              avatar.description,
              avatar.name, avatar.imageUrl
            );

            // Post the avatars personality to the inner monologue channel
            sendAsWebhook(
              avatar.innerMonologueChannel,
              `Personality: ${avatar.personality}`,
              avatar.name, avatar.imageUrl
            );


            // Post the avatars Dynamic Personality to the inner monologue channel
            sendAsWebhook(
              avatar.innerMonologueChannel,
              `Dynamic Personality: ${avatar.dynamicPersonality}`,
              avatar.name, avatar.imageUrl
            );
          }
        }
      }

      const decision = await this.makeDecision(avatar, context, client);
      return decision.decision === 'YES';

    } catch (error) {
      this.logger.error(`Error in shouldRespond: ${error.message}`);
      return false;
    }
  }

  avatarLastCheck = {};
  async makeDecision(avatar, context, client) {

    this.avatarLastCheck[avatar._id] = this.avatarLastCheck[avatar._id] || {
      decision: 'NO',
      timestamp: Date.now()
    }

    // if the last decision was made less than 5 minutes ago, return the same decision
    if (Date.now() - this.avatarLastCheck[avatar._id].timestamp < 5 * 60 * 1000) {
      return this.avatarLastCheck[avatar._id];
    }


    // if the last message was from the avatar, don't respond
    if (context.length && context[context.length - 1].role === 'assistant' && `${context[context.length - 1].content}`.startsWith(avatar.name + ':')) {
      return { decision: 'NO', reason: 'Last message was from the avatar.' };
    }

    // if the last four messages were from bots, don't respond
    if (context.length >= 4 && context.every(m => m.role === 'assistant')) {
      return { decision: 'NO', reason: 'Last four messages were from bots.' };
    }

    // if the last message mentioned the avatar, respond
    if (context.length && `${context[context.length - 1].content}`.toLowerCase().includes(avatar.name.toLowerCase())) {
      return { decision: 'YES', reason: 'Last message mentioned the avatar.' };
    }

    // if the last message mentioned the avatars emoji, respond
    if (context.length && `${context[context.length - 1].content}`.includes(avatar.emoji)) {
      return { decision: 'YES', reason: 'Last message mentioned the avatar emoji.' };
    }


    try {

      const decisionPrompt = [
        ...context, { role: 'user', content: `As ${avatar.name}, analyze the conversation with a haiku.
        Then, on a new line, respond with "YES" if it indicates you should respond. Or "NO" to remain silent.` }
      ];
      const aiResponse = await this.aiService.chat(decisionPrompt, { model: DECISION_MODEL });

      console.log(`${avatar.name} thinks: `, aiResponse);
      const aiLines = aiResponse.split('\n').map(l => l.trim());
      const decision = (aiLines[aiLines.length - 1].toUpperCase().indexOf('NO') !== -1) ? { decision: 'NO' } : { decision: 'YES' };
      decision.reason = aiLines.slice(0, -1).join('\n').trim();

      // Post the haiku to the avatars inner monologue
      if (avatar.innerMonologueChannel) {
        sendAsWebhook(
          avatar.innerMonologueChannel,
          aiLines.slice(0, -1).join('\n').trim(),
          avatar.name, avatar.imageUrl
        );
      }

      if (!decision.decision || !decision.reason) {
        this.logger.warn(`Invalid decision format from AI for avatar ${avatar.id}`);
        return { decision: 'NO', reason: 'Invalid decision format.' };
      }

      return decision;
    } catch (error) {
      this.logger.error(`Error making decision for avatar ${avatar.id}: ${error.message}`);
      return { decision: 'NO', reason: 'Error processing decision.' };
    }
  }
}