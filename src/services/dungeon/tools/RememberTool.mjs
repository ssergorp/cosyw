import { MemoryService } from '../../memoryService.mjs';
import { BaseTool } from './BaseTool.mjs';

export class RememberTool extends BaseTool {
  async execute(message, params, avatar) {
    if (!params || params.length === 0) {
      return '❌ Please specify something to remember.';
    }

    const memory = params.join(' ');
    const memoryService = new MemoryService(this.logger);
    await memoryService.addMemory(avatar._id, memory);

    return `🧠 Memory stored: "${memory}"`;
  }

  getDescription() {
    return 'Remember an important fact for later.';
  }

  getSyntax() {
    return '!remember <fact>';
  }
}