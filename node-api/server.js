import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import { initDatabase, query } from "./db.js";
import modulesRouter from "./routes/modules.js";
import moduleInstancesRouter from "./routes/moduleInstances.js";
import moduleDataRouter from "./routes/moduleData.js";
import calendarRouter from "./routes/calendar.js";
import expensesRouter from "./routes/expenses.js";
import expenseCategoriesRouter from "./routes/expenseCategories.js";
dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Initialize database connection
initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
});

// Available models
const LLM = {
  llama3: "llama3",
  llama3_2_vision: "llama3.2-vision:11b",
  mistral: "mistral",
  uncensored: "dolphin-mixtral:8x7b",

  mistral_vision: "mistral-vision:7b", // not pulled
  qwen: "qwen2.5-coder:14b", // not pulled
  qwen_vision: "qwen2.5-coder-vision:14b", // not pulled
  qwen_2_5_coder: "qwen2.5-coder:14b", // not pulled
  qwen_2_5_coder_vision: "qwen2.5-coder-vision:14b", // not pulled
};

const API_KEY = process.env.API_KEY;
const NUTRITION_MODEL = LLM.llama3_2_vision;
const HOME_ASSISTANT_MODEL = LLM.llama3_2_vision;
const GENERIC_MODEL = LLM.llama3_2_vision;
const UNCENSORED_MODEL = LLM.uncensored;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://home-ai-ollama:11434/api/generate";

// Middleware for authentication
function authenticate(req, res, next) {
  const clientKey = req.headers["x-api-key"];
  if (!clientKey || clientKey !== API_KEY) {
    return res.status(403).json({ error: "Forbidden: Invalid API key" });
  }
  next();
}

// Nutrition endpoint
app.post("/api/nutrition", authenticate, async (req, res) => {
  const { query } = req.body;
  try {
    const response = await axios.post(OLLAMA_URL, {
      model: NUTRITION_MODEL,
      prompt: query,
      stream: false
    });

    const output = response.data.response;

    res.json({ result: output });
  } catch (err) {
    console.error("Ollama request error:", err.message);
    console.error("Full error:", err);
    res.status(500).json({ error: "Ollama request failed", details: err.message });
  }
});

// Home Assistant endpoint
app.post("/api/home-assistant", authenticate, async (req, res) => {
  const { message } = req.body;
  try {
    const response = await axios.post(OLLAMA_URL, {
      model: HOME_ASSISTANT_MODEL,
      prompt: `You are a helpful AI home assistant.
      User: ${message}`,
      stream: false
    });

    const output = response.data.response;

    res.json({ reply: output });
  } catch (err) {
    console.error("Ollama request error:", err.message);
    console.error("Full error:", err);
    res.status(500).json({ error: "Ollama request failed", details: err.message });
  }
});

// Generic AI endpoint
app.post("/api/ai", authenticate, async (req, res) => {
  const { query } = req.body;
  try {
    const response = await axios.post(OLLAMA_URL, {
      model: GENERIC_MODEL,
      prompt: query,
      stream: false
    });

    const output = response.data.response;

    res.json({ result: output });
  } catch (err) {
    console.error("Ollama request error:", err.message);
    console.error("Full error:", err);
    res.status(500).json({ error: "Ollama request failed", details: err.message });
  }
});

// Generic Stream endpoint
app.post("/api/ai/stream", authenticate, async (req, res) => {
  const { query, system_prompt = "", character_name = "", conversation_history = [] } = req.body;

  // Build conversation context from history
  let conversationContext = "";
  if (conversation_history && conversation_history.length > 0) {
    conversationContext = "\n\nPrevious conversation:\n";
    conversation_history.forEach(msg => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      conversationContext += `${role}: ${msg.content}\n`;
    });
  }

  // Construct the full prompt with context
  let prompt = "";
  if (system_prompt) {
    prompt += `${system_prompt}\n`;
  }
  if (character_name) {
    prompt += `You are ${character_name}.\n`;
  }
  if (conversationContext) {
    prompt += conversationContext;
  }
  prompt += `\nUser: ${query}\nAssistant:`;

  try {
    // Set headers for streaming response
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const response = await axios.post(OLLAMA_URL, {
      model: UNCENSORED_MODEL,
      prompt: prompt,
      stream: true
    }, {
      responseType: 'stream'
    });

    // Stream the response from Ollama to the client
    response.data.on('data', (chunk) => {
      try {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const data = JSON.parse(line);
            if (data.response) {
              res.write(data.response);
            }
            if (data.done) {
              res.end();
              return;
            }
          }
        }
      } catch (parseErr) {
        console.error('Error parsing streaming response:', parseErr);
      }
    });

    response.data.on('end', () => {
      res.end();
    });

    response.data.on('error', (streamErr) => {
      console.error('Stream error:', streamErr);
      res.status(500).end('Stream error occurred');
    });

  } catch (err) {
    console.error("Ollama request error:", err.message);
    console.error("Full error:", err);
    res.status(500).json({ error: "Ollama request failed", details: err.message });
  }
});

// Database API routes (no authentication required for internal use)
app.use("/api/modules", modulesRouter);
app.use("/api/module-instances", moduleInstancesRouter);
app.use("/api/module-data", moduleDataRouter);
app.use("/api/calendar", calendarRouter);
app.use("/api/expense-categories", expenseCategoriesRouter);
app.use("/api/expenses", expensesRouter);

// Health check endpoint (includes database check)
app.get("/api/health", async (req, res) => {
  try {
    // Test database connection
    await query('SELECT 1');
    res.json({ 
      status: "healthy", 
      database: "connected",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ 
      status: "unhealthy", 
      database: "disconnected",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.listen(3000, async () => {
  console.log("Ollama API server running on http://localhost:3000");
  // Initialize database on startup
  const dbConnected = await initDatabase();
  if (dbConnected) {
    console.log("✅ Database ready");
  } else {
    console.log("⚠️  Database connection failed - some features may not work");
  }
});
