import { BaseTool } from './BaseTool.mjs';

export class DefendTool extends BaseTool {
  async execute(message) {
    const avatarId = message.author.id;
    const stats = await this.dungeonService.getAvatarStats(avatarId);
    
    const defenseBoost = 5;
    const boostDuration = 60000; // 1 minute

    // Store original defense to ensure correct removal
    const originalDefense = stats.defense;
    stats.defense += defenseBoost;
    await this.dungeonService.updateAvatarStats(avatarId, stats);
    
    setTimeout(async () => {
      const currentStats = await this.dungeonService.getAvatarStats(avatarId);
      // Only remove boost if defense hasn't been modified by other effects
      if (currentStats.defense === stats.defense) {
        currentStats.defense = originalDefense;
        await this.dungeonService.updateAvatarStats(avatarId, currentStats);
      }
    }, boostDuration);

    return `${message.author.username} takes a defensive stance! Defense increased by ${defenseBoost} for 1 minute.`;
  }

  getDescription() {
    return 'Increase defense temporarily';
  }

  getSyntax() {
    return '!defend';
  }
}