const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize Supabase (only if credentials are provided)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check route
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is running',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Store processing queue in memory - use Map for better state management
let processingQueue = new Map();
let currentlyProcessing = null;
let llmSettings = {
  temperature: 0.7,
  maxOutputTokens: 8192,
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
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    const uploadedFiles = [];
    
    for (let file of files) {
      const id = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      const fileData = {
        id: id,
        filename: file.originalname,
        buffer: file.buffer,
        status: 'queued',
        progress: 0,
        result: null,
        error: null,
        processedAt: null
      };
      
      processingQueue.set(id, fileData);
      uploadedFiles.push({ id, filename: file.originalname });
    }
    
    // Start processing if not already running
    if (!currentlyProcessing) {
      processNextInQueue();
    }
    
    res.json({ 
      success: true, 
      message: `${files.length} files uploaded and queued`,
      files: uploadedFiles,
      queueLength: processingQueue.size 
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get queue status
app.get('/status', (req, res) => {
  const queueArray = Array.from(processingQueue.values()).map(item => ({
    id: item.id,
    filename: item.filename,
    status: item.status,
    progress: item.progress,
    error: item.error,
    hasResult: !!item.result
  }));
  
  res.json({
    queue: queueArray,
    currentlyProcessing: currentlyProcessing ? {
      id: currentlyProcessing.id,
      filename: currentlyProcessing.filename,
      progress: currentlyProcessing.progress,
      status: currentlyProcessing.status
    } : null,
    totalProgress: calculateTotalProgress()
  });
});

// Update LLM settings
app.post('/settings', (req, res) => {
  try {
    llmSettings = { ...llmSettings, ...req.body };
    res.json({ success: true, settings: llmSettings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current settings
app.get('/settings', (req, res) => {
  res.json(llmSettings);
});

// Download result
app.get('/download/:id', (req, res) => {
  const item = processingQueue.get(req.params.id);
  if (item && item.result) {
    // Clean up the result if it's a JSON string
    let cleanedResult = item.result;
    
    // If the result starts with ```json and ends with ```, extract the JSON
    if (cleanedResult.startsWith('```json') && cleanedResult.endsWith('```')) {
      cleanedResult = cleanedResult.slice(7, -3).trim();
    }
    
    // Try to parse and format JSON
    try {
      const parsedResult = JSON.parse(cleanedResult);
      cleanedResult = JSON.stringify(parsedResult, null, 2);
    } catch (e) {
      // If not valid JSON, keep as is
    }
    
    res.json({ 
      filename: item.filename,
      result: cleanedResult,
      processedAt: item.processedAt 
    });
  } else {
    res.status(404).json({ error: 'Result not found' });
  }
});

// Clear completed items (optional endpoint)
app.post('/clear-completed', (req, res) => {
  let cleared = 0;
  for (let [id, item] of processingQueue) {
    if (item.status === 'completed' || item.status === 'error') {
      processingQueue.delete(id);
      cleared++;
    }
  }
  res.json({ success: true, cleared });
});

// Process PDFs
async function processNextInQueue() {
  if (currentlyProcessing) return;
  
  // Find next queued item
  let nextItem = null;
  for (let [id, item] of processingQueue) {
    if (item.status === 'queued') {
      nextItem = item;
      break;
    }
  }
  
  if (!nextItem) return;
  
  currentlyProcessing = nextItem;
  nextItem.status = 'processing';
  
  try {
    console.log(`Processing PDF: ${nextItem.filename}`);
    
    // Extract text from PDF
    updateProgress(nextItem, 10, 'extracting');
    const pdfData = await pdfParse(nextItem.buffer);
    
    if (!pdfData.text || pdfData.text.trim().length === 0) {
      throw new Error('No text content found in PDF');
    }
    
    updateProgress(nextItem, 30, 'preparing');
    
    // Process with Gemini
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('Gemini API key not configured');
    }
    
    // Use gemini-2.5-pro
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-pro",
      generationConfig: {
        temperature: llmSettings.temperature,
        maxOutputTokens: llmSettings.maxOutputTokens,
      }
    });
    
    // Increased text length limit to 500,000 characters
    const maxTextLength = 500000;
    const truncatedText = pdfData.text.length > maxTextLength 
      ? pdfData.text.substring(0, maxTextLength) + '...[truncated]'
      : pdfData.text;
    
    const prompt = `${llmSettings.prompt}\n\nDocument content:\n${truncatedText}`;
    
    updateProgress(nextItem, 50, 'analyzing');
    
    console.log(`Sending to Gemini API...`);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    updateProgress(nextItem, 80, 'finalizing');
    
    nextItem.result = response.text();
    nextItem.status = 'completed';
    nextItem.processedAt = new Date();
    updateProgress(nextItem, 100, 'completed');
    
    console.log(`Completed processing: ${nextItem.filename}`);
    
    // Save to Supabase if configured
    if (supabase) {
      await saveToSupabase(nextItem);
    }
    
  } catch (error) {
    console.error(`Error processing ${nextItem.filename}:`, error);
    nextItem.status = 'error';
    nextItem.error = error.message;
    nextItem.progress = 0;
  }
  
  // Clear current processing reference
  currentlyProcessing = null;
  
  // Process next item after a short delay
  setTimeout(() => processNextInQueue(), 1000);
}

// Helper function to update progress
function updateProgress(item, progress, subStatus = null) {
  item.progress = progress;
  if (subStatus) {
    item.subStatus = subStatus;
  }
  // Ensure the update is reflected in the Map
  processingQueue.set(item.id, item);
}

// Save results to Supabase
async function saveToSupabase(item) {
  if (!supabase) return;
  
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
    console.log(`Saved to Supabase: ${item.filename}`);
  } catch (error) {
    console.error('Supabase save error:', error);
    // Don't throw - we don't want Supabase errors to break PDF processing
  }
}

// Calculate total progress
function calculateTotalProgress() {
  if (processingQueue.size === 0) return 100;
  
  let totalProgress = 0;
  for (let [id, item] of processingQueue) {
    totalProgress += item.progress;
  }
  
  return Math.round(totalProgress / processingQueue.size);
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Gemini API Key: ${process.env.GEMINI_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`Supabase: ${supabase ? 'Configured' : 'Not configured'}`);
});
