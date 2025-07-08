const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// === ROUTE REQUIRES ===
const dictionaryBuilderRoutes = require('./dictionary-builder-routes.js');
const dictionaryRoutes = require('./dictionary-routes.js');
const linguisticRoutes = require('./linguistic-routes.js');
const translatorRoutes = require('./translator-routes.js');
const corpusBuilderRoutes = require('./corpus-builder.js');
const dictionaryCleanerRoutes = require('./dictionary-cleaner-routes.js');

// Create axios instance with no timeout
const axiosInstance = axios.create({
  timeout: 0,
  maxContentLength: Infinity,
  maxBodyLength: Infinity
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// This client is now only used for the old PDF analyzer's "Save" feature.
// It will be safely ignored if the old SUPABASE_URL is not set.
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  console.warn("Legacy SUPABASE_URL is set, but should be phased out. The old PDF Analyzer will use it for saving.");
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
}

// === MIDDLEWARE ===
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// === API ROUTES ===
app.use('/dictionary-builder', dictionaryBuilderRoutes);
app.use('/dictionary', dictionaryRoutes);
app.use('/linguistic', linguisticRoutes);
app.use('/translator', translatorRoutes);
app.use('/corpus', corpusBuilderRoutes);
app.use('/dictionary-cleaner', dictionaryCleanerRoutes);

// === PAGE SERVING ROUTES ===
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index-home.html'));
});
app.get('/dictionary-viewer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dictionary-viewer.html'));
});
app.get('/pdf-analyzer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/dictionary-builder', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dictionary.html'));
});
app.get('/linguistic-cleaner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'linguistic.html'));
});
app.get('/corpus-builder', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'corpus-builder.html'));
});
app.get('/dictionary-cleaner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dictionary-cleaner.html'));
});

// Health check route
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Server is running',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// === PDF ANALYSIS LOGIC (UNCHANGED) ===

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit per file
});

// Store processing queue in memory
let processingQueue = new Map();
let globalLogs = [];
let currentlyProcessing = null;

let llmSettings = {
  temperature: 0.6,
  maxOutputTokens: 65000,
  prompt: `Prompt für LLM zur Extraktion des Ahrhammar Wörterbuchs (V3.2 - Final & Optimiert)
I. ROLLE & ZIEL
Du bist ein hochpräziser linguistischer Daten-Extraktor. Deine Mission ist die fehlerfreie Analyse und Konvertierung von Einträgen aus dem Ahrhammar-Wörterbuch in ein perfekt strukturiertes, datenbankfähiges JSON-Format.
Dein oberstes Gebot ist die Sense-zentrische Extraktion: Jeder eigenständige Wortsinn (sense) wird zu einem separaten JSON-Objekt. Ein deutscher Headword-Eintrag mit drei nummerierten Bedeutungen (1., 2., 3.) erzeugt exakt drei JSON-Objekte.
II. HEURISTIKEN & INTERPRETATIONSREGELN (ENTSCHEIDEND)
Bevor du mit der Extraktion beginnst, verinnerliche diese Interpretationsregeln, um die Konventionen des Wörterbuchs wie ein Experte zu deuten:
Pluralbildung & Normalisierung:
Halunder-Plural: Eine Endung wie -er nach einem Halunder-Wort (z.B. Diirt, -er) bedeutet, dass du den Plural selbst konstruieren musst: plural: "Diirter". Wenn die Pluralform bereits vollständig ist (z.B. Kürrownat, -neet), übernimmst du sie direkt als plural: "Kürrowneet".
Stichwort-Normalisierung (Deutsch): Aade, die -> headword: "Aade". aalen, sich -> headword: "aalen". Der Artikel/Reflexivpronomen wird in die Grammatikfelder (gender: "F", isReflexive: true) verschoben.
Term-Normalisierung (Halunder): de Oad -> term: "Oad". hem nobbe -> term: "nobbe". Grammatische Zusätze werden entfernt und in die entsprechenden Felder verschoben.
Deutung von Klammern und Symbolen:
(...): Enthalten meist Aussprache, grammatische Infos oder Alternativformen.
[...]: Enthalten fast immer eine phonetische Transkription.
„...": Sind oft wörtliche Übersetzungen oder Erklärungen. Erfasse diese als note.
* (Stern): Markiert ein Wort als rekonstruiert oder ungewöhnlich. Erfasse dies als isReconstructed: true.
/ (Schrägstrich): Trennt alternative Schreibweisen oder Formen. Oaber(s)/oawer(s) wird zu zwei separaten term-Einträgen im translations-Array.
Implizite Beziehungen & Komposita:
Wortstamm-Analyse: Wenn Einträge wie Aalkorb und Aalreuse unter Aal im Wörterbuch erscheinen, muss bei Aalkorb und Aalreuse eine Relation { "type": "component_of", "targetTerm": "Aal", "targetLanguage": "de" } hinzugefügt werden.
Komposita-Listen: Wenn unter einem Eintrag (z.B. In) eine Liste von Komposita (Inskleet, Instschich) steht, muss jeder dieser Komposita-Einträge als separates, vollständiges JSON-Objekt verarbeitet werden, als wäre er ein eigenständiger Eintrag im Wörterbuch.
Synonyme im Fließtext: Wenn ein Halunder-Wort in der Erklärung eines anderen auftaucht (z.B. ufknuie bei der Beschreibung von sich abarbeiten), ist dies eine synonym-Beziehung. Erfasse es im translations-Array des entsprechenden Sinns.
Kontext von Notizen: Eine Quellenangabe am Ende einer Zeile ((M., Br.)) bezieht sich auf die gesamte Aussage in dieser Zeile und wird zur note des entsprechenden examples-Objekts. Eine Anmerkung in Klammern direkt nach einem Wort bezieht sich nur auf dieses Wort und wird zur note des entsprechenden translations-Objekts.
III. PARSING-REGELN & JSON-STRUKTUR
Verwende die folgende, exakte Struktur für jedes generierte JSON-Objekt:
1. HAUPTEINTRAG (HEADWORD & SENSE)
headword (string): Das deutsche Stichwort, normalisiert.
headwordLanguage (string): Immer 'de'.
senseId (string): Eindeutiger Identifikator: {headword}-{homonymNumber}-{senseNumber}.
senseNumber (integer): Nummer der Bedeutung (1, 2, ...), Standard ist 1.
germanDefinition (string): Eine präzise deutsche Beschreibung des aktuellen Sinns.
partOfSpeech (string): Wortart (noun, verb, adjective, idiom, etc.).
homonymNumber (integer): Nur wenn das deutsche Stichwort eine hochgestellte Zahl hat.
usageNotes (Array von Strings): Kontextinformationen wie seem., veralt., abwertend.
isReconstructed (boolean): true, wenn mit * markiert.
isReflexive (boolean): true, wenn das deutsche Stichwort sich enthält oder das Halunder-Beispiel hem.
2. ÜBERSETZUNGEN (TRANSLATIONS)
translations (Array von Objekten): Ein Array, das immer verwendet wird, um Halunder-Übersetzungen für diesen spezifischen Sinn zu speichern.
Struktur pro Objekt:
term (string): Das Halunder-Wort, normalisiert.
language (string): Immer 'hal'.
pronunciation (string): Ausspracheinfo.
gender (string): M, F, N.
plural (string): Die vollständige, konstruierte Pluralform.
etymology (string): Herkunftsinformationen.
note (string): Kurze Zusatzanmerkungen.
3. BEZIEHUNGEN (RELATIONS)
relations (Array von Objekten): Erfasst alle internen Wortverweise.
Struktur pro Objekt:
type (string): Wähle aus: 'see_also' (für vgl., s.), 'synonym', 'antonym', 'etymological_origin', 'component_of' (für Komposita-Teile).
targetTerm (string): Das Zielwort, normalisiert.
targetLanguage (string): 'de' oder 'hal'.
note (string): Zusatzinfos wie Bedeutung 1. oder Kontext.
4. BEISPIELE (EXAMPLES)
examples (Array von Objekten): Anwendungsbeispiele für diesen spezifischen Sinn.
Struktur pro Objekt:
type (string): Wähle aus: 'bilingual_sentence', 'usage_description', 'idiom'.
halunder (string): Halunder-Teil.
german (string): Deutscher Teil.
descriptionText (string): Nur bei usage_description.
descriptionLanguage (string): Sprache des descriptionText.
note (string): Quellenangaben oder wörtliche Erklärungen.
5. QUELLENANGABEN (SOURCE CITATIONS)
sourceCitations (Array von Strings): Sammelt alle externen, bibliographischen Verweise ((Helg. 455, 19)).
IV. ANWENDUNGSBEISPIEL (KOMPLEX)
Wenn du diesen Text siehst:
abarbeiten 1. (etw.) ufoarbooide; vgl. abverdienen 2. sich a. hem ufoarbooide, hem ufknuie, hem ufrak (< ndt. sik afrieten); vgl. sich abmühen
Dann musst du ZWEI separate JSON-Objekte generieren:
Objekt 1 (Sinn 1: transitiv):
{
  "headword": "abarbeiten",
  "headwordLanguage": "de",
  "senseId": "abarbeiten-1-1",
  "senseNumber": 1,
  "germanDefinition": "etwas abarbeiten (transitiv)",
  "partOfSpeech": "verb",
  "translations": [
    { "term": "ufoarbooide", "language": "hal" }
  ],
  "relations": [
    { "type": "see_also", "targetTerm": "abverdienen", "targetLanguage": "de" }
  ]
}
Objekt 2 (Sinn 2: reflexiv):
{
  "headword": "abarbeiten",
  "headwordLanguage": "de",
  "senseId": "abarbeiten-1-2",
  "senseNumber": 2,
  "germanDefinition": "sich abarbeiten (reflexiv)",
  "partOfSpeech": "verb",
  "isReflexive": true,
  "translations": [
    { "term": "ufoarbooide", "language": "hal" },
    { "term": "ufknuie", "language": "hal" },
    { "term": "ufrak", "language": "hal", "etymology": "< ndt. sik afrieten" }
  ],
  "relations": [
    { "type": "see_also", "targetTerm": "abmühen, sich", "targetLanguage": "de" }
  ],
  "examples": [
    { "type": "bilingual_sentence", "halunder": "hem ufoarbooide", "german": "sich abarbeiten" },
    { "type": "bilingual_sentence", "halunder": "hem ufknuie", "german": "sich abarbeiten" },
    { "type": "bilingual_sentence", "halunder": "hem ufrak", "german": "sich abarbeiten" }
  ]
}
AUFGABE:
Analysiere nun den folgenden Wörterbuchtext penibel genau und extrahiere ALLE Einträge gemäß den oben definierten, detaillierten Regeln und Heuristiken. Achte besonders auf die sense-zentrische Zerlegung, die korrekte Interpretation impliziter Informationen und die vollständige Normalisierung aller Begriffe. Gib deine Ausgabe als eine einzelne JSON-Liste von Objekten aus, ohne irgendwelche zusätzlichen Sätze und Einleitungen wie "Hier ist die JSON", etc.`
};

app.post('/upload', upload.array('pdfs', 100), async (req, res) => {
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
        result: null,
        error: null,
        processedAt: null,
        retryCount: 0
      };
      processingQueue.set(id, fileData);
      uploadedFiles.push({ id, filename: file.originalname });
    }
    addLog(`${files.length} files added to queue. Total in queue: ${processingQueue.size}`, 'info');
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

app.get('/status', (req, res) => {
  const queueArray = Array.from(processingQueue.values()).map(item => ({
    id: item.id,
    filename: item.filename,
    status: item.status,
    error: item.error,
    hasResult: !!item.result
  }));
  res.json({
    queue: queueArray,
    logs: globalLogs,
    currentlyProcessing: currentlyProcessing ? {
      id: currentlyProcessing.id,
      filename: currentlyProcessing.filename,
      status: currentlyProcessing.status
    } : null
  });
});

app.post('/settings', (req, res) => {
  try {
    llmSettings = { ...llmSettings, ...req.body };
    res.json({ success: true, settings: llmSettings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/settings', (req, res) => {
  res.json(llmSettings);
});

app.get('/download/:id', (req, res) => {
  const item = processingQueue.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'File not found' });
  if (!item.result) return res.status(404).json({ error: 'Result not available yet' });
  let cleanedResult = item.result;
  if (cleanedResult.startsWith('```json') && cleanedResult.endsWith('```')) {
    cleanedResult = cleanedResult.slice(7, -3).trim();
  }
  try {
    const parsedResult = JSON.parse(cleanedResult);
    cleanedResult = JSON.stringify(parsedResult, null, 2);
  } catch (e) {}
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${item.filename}_analysis.json"`);
  res.send(cleanedResult);
});

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

app.post('/clear-logs', (req, res) => {
  globalLogs = [];
  res.json({ success: true });
});

function addLog(message, type = 'info', filename = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type,
    filename,
    id: Date.now() + Math.random()
  };
  globalLogs.push(logEntry);
  if (globalLogs.length > 1000) {
    globalLogs = globalLogs.slice(-1000);
  }
  console.log(`[${filename || 'SYSTEM'}] ${message}`);
}

async function callGeminiAPI(prompt, temperature, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  const apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';

  try {
    const response = await axiosInstance.post(
      apiUrl,
      {
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: temperature,
          maxOutputTokens: maxTokens,
          candidateCount: 1
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        }
      }
    );

    if (response.data && response.data.candidates && response.data.candidates[0]) {
      return response.data.candidates[0].content.parts[0].text;
    }
    throw new Error('Invalid response format from Gemini API');

  } catch (error) {
    if (error.response) {
      throw new Error(`Gemini API error: ${error.response.status} - ${error.response.data.error?.message || error.response.statusText}`);
    } else if (error.request) {
      throw new Error('No response from Gemini API - request timeout or network error');
    } else {
      throw error;
    }
  }
}

async function processNextInQueue() {
  if (currentlyProcessing) return;

  let nextItem = null;
  for (let [id, item] of processingQueue) {
    if (item.status === 'queued') {
      nextItem = item;
      break;
    }
  }

  if (!nextItem) {
    addLog('All files processed. Queue is empty.', 'success');
    return;
  }

  currentlyProcessing = nextItem;
  nextItem.status = 'processing';

  try {
    addLog(`Starting processing of ${nextItem.filename} (${getQueuedCount()} more in queue)`, 'info', nextItem.filename);

    addLog('Extracting text from PDF...', 'info', nextItem.filename);
    const pdfData = await pdfParse(nextItem.buffer);

    if (!pdfData.text || pdfData.text.trim().length === 0) {
      throw new Error('No text content found in PDF');
    }

    const textLength = pdfData.text.length;
    addLog(`Extracted ${textLength} characters from PDF`, 'info', nextItem.filename);

    if (!process.env.GEMINI_API_KEY) {
      throw new Error('Gemini API key not configured');
    }

    const maxTextLength = 1000000;
    const truncatedText = pdfData.text.length > maxTextLength
      ? pdfData.text.substring(0, maxTextLength) + '...[truncated]'
      : pdfData.text;

    if (truncatedText !== pdfData.text) {
      addLog(`Text truncated to ${maxTextLength} characters`, 'warning', nextItem.filename);
    }

    const prompt = `${llmSettings.prompt}\n\nDocument content:\n${truncatedText}`;

    addLog('Sending to Gemini API for analysis...', 'info', nextItem.filename);
    addLog(`Using temperature: ${llmSettings.temperature}, max tokens: ${llmSettings.maxOutputTokens}`, 'info', nextItem.filename);

    const startTime = Date.now();
    const result = await callGeminiAPI(prompt, llmSettings.temperature, llmSettings.maxOutputTokens);
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    addLog(`Received response from Gemini API after ${processingTime}s`, 'success', nextItem.filename);

    nextItem.result = result;
    nextItem.status = 'completed';
    nextItem.processedAt = new Date();

    addLog(`Processing completed successfully for ${nextItem.filename}`, 'success', nextItem.filename);

    if (supabase) {
      try {
        await saveToSupabase(nextItem);
        addLog('Saved to Supabase', 'success', nextItem.filename);
      } catch (error) {
        addLog(`Supabase save failed: ${error.message}`, 'warning', nextItem.filename);
      }
    }

  } catch (error) {
    console.error(`Error processing ${nextItem.filename}:`, error);
    const errorMessage = error.message || 'Unknown error';

    if ((errorMessage.includes('timeout') || errorMessage.includes('network') || errorMessage.includes('ECONNRESET')) && nextItem.retryCount < 3) {
      nextItem.retryCount++;
      nextItem.status = 'queued';
      addLog(`Error: ${errorMessage}. Will retry (attempt ${nextItem.retryCount + 1}/4)`, 'warning', nextItem.filename);
      await new Promise(resolve => setTimeout(resolve, 30000));
    } else {
      addLog(`Error: ${errorMessage}`, 'error', nextItem.filename);
      nextItem.status = 'error';
      nextItem.error = errorMessage;
    }
  }

  currentlyProcessing = null;
  setTimeout(() => processNextInQueue(), 3000);
}

function getQueuedCount() {
  let count = 0;
  for (let [id, item] of processingQueue) {
    if (item.status === 'queued') count++;
  }
  return count;
}

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
    throw error;
  }
}

// === ERROR HANDLING & SERVER START ===
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`SOURCE Supabase (Primary): ${process.env.SOURCE_SUPABASE_URL ? 'Configured' : 'Not configured'}`);
});
