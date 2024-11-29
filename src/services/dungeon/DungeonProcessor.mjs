export class DungeonProcessor {
  constructor(dungeonService, logger) {
    this.dungeonService = dungeonService;
    this.logger = logger;
    this.commandPrefix = '!';
    this.commands = ['attack', 'defend', 'move'];
    this.avatarTracker = null;
    this.avatarService = null;
  }

  setServices(avatarTracker, avatarService) {
    this.avatarTracker = avatarTracker;
    this.avatarService = avatarService;
    this.dungeonService.setAvatarService(avatarService);
  }

  async processMessage(message) {
    if (!message.content.startsWith(this.commandPrefix)) return;

    const [command, ...params] = message.content
      .slice(this.commandPrefix.length)
      .trim()
      .split(/\s+/);

    if (!this.commands.includes(command)) return;

    try {
      // Extract commands first
      const { commands, cleanText } = this.dungeonService.extractToolCommands(message.content);
      
      // Handle attention before processing commands
      if (commands.some(cmd => ['attack', 'defend'].includes(cmd.command))) {
        const avatarsInChannel = this.avatarTracker.getAvatarsInChannel(message.channel.id);
        for (const avatarId of avatarsInChannel) {
          // Initialize/increase attention safely
          this.avatarTracker.addAvatarToChannel(message.channel.id, avatarId, message.guild.id);
          this.avatarTracker.increaseAttention(message.channel.id, avatarId, 2);
        }
      }

      // Process commands
      for (const { command, params } of commands) {
        const result = await this.dungeonService.processAction(message, command, params);
        if (result) {
          await message.channel.send(result);
        }
      }
    } catch (error) {
      this.logger.error(`Error processing dungeon command: ${error.message}`);
    }
  }

  async checkPendingActions() {
    // Poll database for pending actions
    const actions = (await this.getPendingActions() || []);
    for (const action of actions) {
      await this.executeAction(action);
    }
  }

  async getPendingActions() {
    // Implementation to fetch pending actions from MongoDB
  }

  async executeAction(action) {
    // Implementation to execute a pending action
  }
}