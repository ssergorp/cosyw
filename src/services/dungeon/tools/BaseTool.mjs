export class BaseTool {
  constructor(dungeonService) {
    this.dungeonService = dungeonService;
  }

  async execute(message, params) {
    throw new Error('Tool must implement execute method');
  }

  getDescription() {
    throw new Error('Tool must implement getDescription method');
  }

  getSyntax() {
    throw new Error('Tool must implement getSyntax method');
  }
}