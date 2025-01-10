Repository: Cosyworld

Description: CosyWorld is a Discord bot that creates and manages
AI-powered avatars capable of interacting with users, engaging in 
conversations, and participating in a dungeon-like game environment

Before setting up CosyWorld, ensure you have the following:

    Node.js v18 or higher
    MongoDB database
    Discord Bot Token: Create a Discord bot and obtain its token.
    OpenRouter API Key or Ollama setup for AI model integration

Environment Variables

Create a .env file in the root directory of your project and configure the following environment variables:

DISCORD_BOT_TOKEN="your_discord_bot_token"
MONGO_URI="mongodb://127.0.0.1:27017"
REPLICATE_API_TOKEN="your_replicate_api_token"
REPLICATE_MODEL="immanencer/mirquo:dac6bb69d1a52b01a48302cb155aa9510866c734bfba94aa4c771c0afb49079f"

OPENROUTER_API_TOKEN="your_openrouter_api_token"
OPENROUTER_MODEL="openai/gpt-4o"

MONGO_DB_NAME='cosyworld'

S3_API_ENDPOINT="your_s3_api_endpoint"
S3_API_KEY="your_s3_api_key"
CLOUDFRONT_DOMAIN="your_cloudfront_domain"

Note: Ensure that the .env file is added to your .gitignore to keep sensitive information secure.

Directory Structure:
- src/: Main application code

Setup:
- Run `npm install` to install dependencies
- Create a .env file in the root directory.
- Add the required environment variables as shown in the Environment Variables section.

- Use `npm run dev` for development
- Run `npm start` to start the Bot

Usage:

Once the bot is running, you can interact with it using the following commands and access the web dashboard for more functionalities.
Bot Commands

Use these slash commands to interact with your avatars:

- !summon [name or description] Description: Summons the named avatar to the current channel, or creates a new one.
- !breed [avatar1] [avatar2] Description: Breed two avatars to create a new one with combined traits.
    Parameters:
    avatar1 - The first avatar to breed.
    avatar2 - The second avatar to breed.

- !attack [avatar] Description: Attack another avatar in the same channel.
    Parameters:
    avatar - The avatar to attack.

Dashboard:

- Access the web dashboard to manage and monitor your avatars:
    URL: http://localhost:3000

    Monitor Avatar Statistics: View detailed stats for each avatar.
    Interaction History: Track past conversations and interactions between avatars.
    Manage Avatar Settings: Customize avatar attributes and behaviors.
    Track Dungeon Progress: Monitor avatar progress and achievements in the dungeon system.

S3 Setup:

-  To enable image uploads, you must set up an S3-compatible storage bucket. This allows avatars to upload and store images used in the bot. Refer to this guide for detailed instructions on creating and configuring an S3 bucket. You will need the following information:

    S3 API Key: Used for authentication.
    S3 API Endpoint: The endpoint for your storage bucket.
    CloudFront Domain: (Optional) A CDN domain to serve your images more efficiently


Guidelines:
- Follow ESLint configuration
- Write tests for all new features
- Use TypeScript for new code
