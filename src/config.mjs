import process from "process";
import dotenv from "dotenv";
dotenv.config();

export default {
    mongo: {
        uri: process.env.MONGO_URI
    },
    discord: {
        botToken: process.env.DISCORD_BOT_TOKEN
    },
    x: {
        // x service configuration
    }
}