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

  async shouldRespond(channel, avatar) {
    // Validate channel and avatar
    if (!channel || !channel.id || typeof channel.id !== 'string') {
      this.logger.error('Invalid channel provided to shouldRespond:', channel);
      return false;
    }

    // get the latest few messages in the channel
    const channelMessages = await channel.messages.fetch({ limit: 18 });
    const lastMessage = channelMessages.first();

    // If last message is from a bot and mentions the avatar
    if (lastMessage?.author.bot) {
      // if the author username is the same as the avatar name, don't respond
      if (lastMessage.author.username.toLowerCase() === avatar.name.toLowerCase()) {
        return false;
      }
      const isAvatarMentioned = lastMessage.content.toLowerCase().includes(avatar.name.toLowerCase()) ||
                              (avatar.emoji && lastMessage.content.includes(avatar.emoji));
      if (isAvatarMentioned) {
        return true;
      }
    }

    // calculate the percentage of messages that are from .bot
    const botMessageCount = channelMessages.filter(m => m.author.bot).size;
    const botMessagePercentage = (botMessageCount / channelMessages.size) - 0.1;

    // randomly decide whether to respond based on the bot message percentage
    const shouldRespond = lastMessage.author.bot ? Math.random() > botMessagePercentage: true;
    if (!shouldRespond) {
      console.log('Bot message percentage:', botMessagePercentage);
      return false;
    }

    const avatarId = avatar.id || avatar._id.toString();
    
    if (!avatarId || !avatar.name) {
      this.logger.error('DecisionMaker received avatar with missing id or name:', JSON.stringify(avatar, null, 2));
      return false;
    }

    try {
        // Get recent messages for context
        const messages = await channel.messages.fetch({ limit: 5 });
        const context = messages.reverse().map(m => ({
          role: m.author.bot ? 'assistant' : 'user',
          content: `${m.author.username}: ${m.content}`
        }));

        const decision = await this.makeDecision(avatar, context);
        return decision.decision === 'YES';

    } catch (error) {
      this.logger.error(`Error in shouldRespond: ${error.message}`);
      return false;
    }
  }

  avatarLastCheck = {};
  async makeDecision(avatar, context, isBackground = false) {

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

    const decisionPrompt = [
      ...context,
      {
        role: 'user',
        content: `As ${avatar.name}, analyze the conversation.
        Describe your thought process and decide whether to respond, and 

        Consider:
        1. Are you mentioned (by name or emoji)?
        2. Is the topic relevant to your interests/personality?
        3. Would your input be valuable?
        4. Is this a good time to speak?
        5. Have you spoken too recently?

        
        Based on these factors, should you respond?
        
        Respond with a Haiku containing your answer (YES or NO) in the final line, and repeat your answer alone on a new line after the haiku.
        `

        
      }
    ];

    try {
      const aiResponse = await this.aiService.chat(decisionPrompt, { model: DECISION_MODEL });
      console.log(`${avatar.name} thinks: `, aiResponse);
      const aiLines = aiResponse.split('\n').map(l => l.trim());
      const decision = (aiLines[aiLines.length - 1].toUpperCase().indexOf('YES') !== -1) ? { decision: 'YES' } : { decision: 'NO' };
      decision.reason = aiLines.slice(0, -1).join('\n').trim();

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