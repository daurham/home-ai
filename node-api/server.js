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
import expenseSettingsRouter from "./routes/expenseSettings.js";
import latencyRouter from "./routes/latency.js";
import choresRouter from "./routes/chores.js";
import habitsRouter from "./routes/habits.js";
import { startLatencyScheduler } from "./lib/latency/index.js";
import { createTunnelGuard } from "./lib/externalAccess.js";
import { buildHomeAssistantPrompt, pipeOllamaStream } from "./lib/homeAssistant.js";
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

// Anything arriving through the Cloudflare tunnel needs the API key; LAN traffic
// (dashboard, latency probes) is untouched. Registered before the routes so it covers
// the database routers too, which have no auth of their own.
app.use(createTunnelGuard({ apiKey: API_KEY }));
if (!API_KEY) {
  console.warn('⚠️  API_KEY is not set — external requests through the tunnel will all be rejected');
}

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

// Shared Ollama chat used by the public home-assistant endpoint (API key) and
// the LAN dashboard route (no key; Cloudflare still requires a key via the tunnel guard).
async function assistantChat(req, res) {
  const { message, conversation_history = [], stream = false } = req.body;
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) {
    return res.status(400).json({ error: "message is required" });
  }

  const prompt = buildHomeAssistantPrompt(text, conversation_history);
  const ollamaBody = { model: HOME_ASSISTANT_MODEL, prompt, stream: Boolean(stream) };

  try {
    if (stream) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const response = await axios.post(OLLAMA_URL, ollamaBody, {
        responseType: "stream",
        timeout: 120000,
      });
      pipeOllamaStream(response.data, res);
      return;
    }

    const response = await axios.post(OLLAMA_URL, ollamaBody, { timeout: 120000 });
    res.json({ reply: response.data.response });
  } catch (err) {
    console.error("Ollama request error:", err.message);
    console.error("Full error:", err);
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(500).json({ error: "Ollama request failed", details: err.message });
  }
}

// External apps (calorie-tracker, tunnel). Key required here and by the CF guard.
app.post("/api/home-assistant", authenticate, assistantChat);

// Household dashboard on the LAN. Same Ollama chat; not published at the Cloudflare edge.
app.post("/api/assistant", assistantChat);

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
app.use("/api/expense-settings", expenseSettingsRouter);
app.use("/api/expenses", expensesRouter);
app.use("/api/latency", latencyRouter);
app.use("/api/chores", choresRouter);
app.use("/api/habits", habitsRouter);

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
  startLatencyScheduler().catch((err) => {
    console.error('[latency] scheduler failed to start:', err?.message || err);
  });
});
