import OpenAI from 'openai';
import models from '../models.config.mjs';

export class OpenRouterService {
  constructor(apiKey) {
    this.model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-3b-instruct';
    this.openai = new OpenAI({
      apiKey: ( apiKey || process.env.OPENROUTER_API_TOKEN),
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://ratimics.com', // Optional, for including your app on openrouter.ai rankings.
        'X-Title': 'rativerse',      // Optional. Shows in rankings on openrouter.ai.
      },
    });
    this.modelConfig = models;
  }

  async selectRandomModel() {
    const rarityWeights = {
      'common': 0.6,
      'uncommon': 0.25,
      'rare': 0.1,
      'legendary': 0.05
    };

    // Select rarity first
    const roll = Math.random();
    let selectedRarity;
    let accumulated = 0;
    
    for (const [rarity, weight] of Object.entries(rarityWeights)) {
      accumulated += weight;
      if (roll <= accumulated) {
        selectedRarity = rarity;
        break;
      }
    }

    // Get all models of selected rarity
    const availableModels = this.modelConfig.filter(m => m.rarity === selectedRarity);
    if (!availableModels.length) return this.model; // Fallback to default

    // Select random model from rarity group
    return availableModels[Math.floor(Math.random() * availableModels.length)].model;
  }

  modelIsAvailable(model) {
    return this.modelConfig.some(m => m.model === model);
  }

  // Method to generate a completion from OpenRouter
  async generateCompletion(prompt, options = {}) {
    try {
      const response = await this.openai.completions.create({
        model: this.model,
        prompt,
        ...options,
      });
      if (!response || !response.choices || response.choices.length === 0) {
        console.error('Invalid response from OpenRouter during completion generation.');
        return null;
      }
      return response.choices[0].text.trim();
    } catch (error) {
      console.error('Error while generating completion from OpenRouter:', error);
      return null;
    }
  }

  // Method to have a chat with OpenRouter
  async chat(messages, options = { model: 'meta-llama/llama-3.2-1b-instruct' }) {
    try {
      const response = await this.openai.chat.completions.create({
        model: options.model || this.model,
        messages: messages.filter(T => T.content),
        ...options,
      });
      if (!response || !response.choices || response.choices.length === 0) {
        console.error('Invalid response from OpenRouter during chat.');
        return null;
      }
      return response.choices[0].message.content.trim() || '...';
    } catch (error) {
      console.error('Error while chatting with OpenRouter:', error);
      return null;
    }
  }
}
