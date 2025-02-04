import ollama from 'ollama';

export class OllamaService {
  constructor() {
    this.model = 'llama2';
    this.modelConfig = [
      { model: 'llama2', rarity: 'common' },
      { model: 'mistral', rarity: 'common' },
      { model: 'codellama', rarity: 'uncommon' },
      { model: 'llama2-uncensored', rarity: 'rare' },
      { model: 'mixtral', rarity: 'legendary' }
    ];
  }

  async selectRandomModel() {
    const rarityRanges = [
      { rarity: 'common', min: 1, max: 12 },        // Common: 1-12 (60%)
      { rarity: 'uncommon', min: 13, max: 17 },    // Uncommon: 13-17 (25%)
      { rarity: 'rare', min: 18, max: 19 },        // Rare: 18-19 (10%)
      { rarity: 'legendary', min: 20, max: 20 },   // Legendary: 20 (5%)
    ];

    // Roll a d20
    const roll = Math.ceil(Math.random() * 20);

    // Determine rarity based on the roll
    const selectedRarity = rarityRanges.find(range => roll >= range.min && roll <= range.max)?.rarity;

    // Filter models by the selected rarity
    const availableModels = this.modelConfig.filter(model => model.rarity === selectedRarity);

    // Return a random model from the selected rarity group or fallback to default
    if (availableModels.length > 0) {
      const randomIndex = Math.floor(Math.random() * availableModels.length);
      return availableModels[randomIndex].model;
    }

    // Fallback to default if no models are found
    return this.model;
  }

  // Method to generate a completion from Ollama
  async generateCompletion(prompt, options = {}) {
    try {
      const response = await ollama.generate({
        model: this.model,
        prompt,
        ...options,
      });
      if (!response || !response.response || response.response.length === 0) {
        console.error('Invalid response from Ollama during completion generation.');
        return null;
      }
      return response.response.trim();
    } catch (error) {
      console.error('Error while generating completion from Ollama:', error);
      return null;
    }
  }

  // Method to have a chat with Ollama
  async chat(messages, options = {}) {
    try {
      const response = await ollama.chat({
        model: this.model,
        messages,
        ...options,
      });
      if (!response || !response.message || !response.message.content) {
        console.error('Invalid response from Ollama during chat.');
        return null;
      }
      return response.message.content.trim();
    } catch (error) {
      console.error('Error while chatting with Ollama:', error);
      return null;
    }
  }
}