export class DecisionMaker {
  constructor(aiService, logger, attentionManager) {
    this.aiService = aiService;
    this.logger = logger;
    this.attentionManager = attentionManager;
  }

  async shouldRespond(channel, avatar) {
    // Validate channel and avatar
    if (!channel || !channel.id || typeof channel.id !== 'string') {
      this.logger.error('Invalid channel provided to shouldRespond:', channel);
      return false;
    }

    // get the latest few messages in the channel
    const channelMessages = await channel.messages.fetch({ limit: 5 });
    // calculate the percentage of messages that are from .bot
    const botMessageCount = channelMessages.filter(m => m.author.bot).size;
    const botMessagePercentage = botMessageCount / channelMessages.size;

    // randomly decide whether to respond based on the bot message percentage
    const shouldRespond = Math.random() > botMessagePercentage;
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
      // Use unified attention manager decision
      const shouldRespond = this.attentionManager.shouldRespond(channel.id, avatarId);
      
      if (shouldRespond) {
        // Get recent messages for context
        const messages = await channel.messages.fetch({ limit: 5 });
        const context = messages.reverse().map(m => ({
          role: m.author.bot ? 'assistant' : 'user',
          content: `${m.author.username}: ${m.content}`
        }));

        const decision = await this.makeDecision(avatar, context);
        return decision.decision === 'YES';
      }

      return false;
    } catch (error) {
      this.logger.error(`Error in shouldRespond: ${error.message}`);
      return false;
    }
  }

  async makeDecision(avatar, context, isBackground = false) {
    // if the last message was from the avatar, don't respond
    if (context.length && context[context.length - 1].role === 'assistant' && `${context[context.length - 1].content}`.startsWith(avatar.name + ':')) {
      return { decision: 'NO', reason: 'Last message was from the avatar.' };
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
      const aiResponse = await this.aiService.chat(decisionPrompt);
      console.log('AI response:', aiResponse);
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