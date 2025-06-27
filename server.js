const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Store processing queue in memory
let processingQueue = [];
let currentlyProcessing = null;
let llmSettings = {
  temperature: 0.7,
  maxOutputTokens: 2048,
  prompt: "Analyze this PDF document and provide a comprehensive summary."
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload PDFs
app.post('/upload', upload.array('pdfs', 20), async (req, res) => {
  try {
    const files = req.files;
    
    for (let file of files) {
      const id = Date.now() + '_' + file.originalname;
      processingQueue.push({
        id: id,
        filename: file.originalname,
        buffer: file.buffer,
        status: 'queued',
        progress: 0,
        result: null
      });
    }
    
    // Start processing if not already running
    if (!currentlyProcessing) {
      processNextInQueue();
    }
    
    res.json({ 
      success: true, 
      message: `${files.length} files uploaded and queued`,
      queueLength: processingQueue.length 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get queue status
app.get('/status', (req, res) => {
  res.json({
    queue: processingQueue.map(item => ({
      id: item.id,
      filename: item.filename,
      status: item.status,
      progress: item.progress
    })),
    currentlyProcessing: currentlyProcessing ? {
      id: currentlyProcessing.id,
      filename: currentlyProcessing.filename,
      progress: currentlyProcessing.progress
    } : null,
    totalProgress: calculateTotalProgress()
  });
});

// Update LLM settings
app.post('/settings', (req, res) => {
  llmSettings = { ...llmSettings, ...req.body };
  res.json({ success: true, settings: llmSettings });
});

// Get current settings
app.get('/settings', (req, res) => {
  res.json(llmSettings);
});

// Download result
app.get('/download/:id', (req, res) => {
  const item = processingQueue.find(i => i.id === req.params.id);
  if (item && item.result) {
    res.json({ 
      filename: item.filename,
      result: item.result,
      processedAt: item.processedAt 
    });
  } else {
    res.status(404).json({ error: 'Result not found' });
  }
});

// Process PDFs
async function processNextInQueue() {
  if (processingQueue.length === 0 || currentlyProcessing) return;
  
  const item = processingQueue.find(i => i.status === 'queued');
  if (!item) return;
  
  currentlyProcessing = item;
  item.status = 'processing';
  
  try {
    // Extract text from PDF
    item.progress = 20;
    const pdfData = await pdfParse(item.buffer);
    
    // Process with Gemini
    item.progress = 50;
    const model = genAI.getGenerativeModel({ 
      model: "gemini-pro",
      generationConfig: {
        temperature: llmSettings.temperature,
        maxOutputTokens: llmSettings.maxOutputTokens,
      }
    });
    
    const prompt = `${llmSettings.prompt}\n\nDocument content:\n${pdfData.text}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    item.progress = 90;
    item.result = response.text();
    item.status = 'completed';
    item.processedAt = new Date();
    item.progress = 100;
    
    // Save to Supabase if configured
    if (process.env.SUPABASE_URL) {
      await saveToSupabase(item);
    }
    
  } catch (error) {
    item.status = 'error';
    item.error = error.message;
    console.error('Processing error:', error);
  }
  
  currentlyProcessing = null;
  
  // Process next item
  setTimeout(() => processNextInQueue(), 1000);
}

// Save results to Supabase
async function saveToSupabase(item) {
  try {
    const { data, error } = await supabase
      .from('pdf_analyses')
      .insert([{
        filename: item.filename,
        result: item.result,
        processed_at: item.processedAt,
        settings: llmSettings
      }]);
    
    if (error) throw error;
  } catch (error) {
    console.error('Supabase save error:', error);
  }
}

// Calculate total progress
function calculateTotalProgress() {
  if (processingQueue.length === 0) return 100;
  const totalProgress = processingQueue.reduce((sum, item) => sum + item.progress, 0);
  return Math.round(totalProgress / processingQueue.length);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
