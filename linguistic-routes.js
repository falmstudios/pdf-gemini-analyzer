const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Add body parser middleware to this router
router.use(express.json());

// Initialize connections with error checking
console.log('Initializing linguistic routes v2...');
console.log('SOURCE_SUPABASE_URL exists:', !!process.env.SOURCE_SUPABASE_URL);
console.log('SOURCE_SUPABASE_ANON_KEY exists:', !!process.env.SOURCE_SUPABASE_ANON_KEY);
console.log('GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);

// Check if we have the required environment variables
if (!process.env.SOURCE_SUPABASE_URL || !process.env.SOURCE_SUPABASE_ANON_KEY) {
    console.error('WARNING: Source Supabase credentials not found!');
}

// Use SOURCE Supabase for everything
const supabase = process.env.SOURCE_SUPABASE_URL && process.env.SOURCE_SUPABASE_ANON_KEY
    ? createClient(
        process.env.SOURCE_SUPABASE_URL,
        process.env.SOURCE_SUPABASE_ANON_KEY
    )
    : null;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// State management
let processingState = {
    isProcessing: false,
    progress: 0,
    status: 'idle',
    details: '',
    logs: [],
    results: null,
    startTime: null
};

// Store the merged data globally for the processing session
let currentMergedMap = null;

// Helper function to add logs
function addLog(message, type = 'info') {
    const log = {
        id: Date.now() + Math.random(),
        message,
        type,
        timestamp: new Date().toISOString()
    };
    processingState.logs.push(log);
    
    // Keep only last 1000 logs
    if (processingState.logs.length > 1000) {
        processingState.logs = processingState.logs.slice(-1000);
    }
    
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// Get statistics
router.get('/stats', async (req, res) => {
    try {
        // Check if database is configured
        if (!supabase) {
            return res.json({
                linguisticFeatures: 0,
                translationAids: 0,
                total: 0,
                processed: 0,
                error: 'Database not configured'
            });
        }
        
        // Get counts from database
        const { count: linguisticCount } = await supabase
            .from('linguistic_features')
            .select('*', { count: 'exact', head: true });
            
        const { count: translationCount } = await supabase
            .from('translation_aids')
            .select('*', { count: 'exact', head: true });
            
        // Get processed count
        const { count: processedCount } = await supabase
            .from('cleaned_linguistic_examples')
            .select('*', { count: 'exact', head: true });
        
        res.json({
            linguisticFeatures: linguisticCount || 0,
            translationAids: translationCount || 0,
            total: (linguisticCount || 0) + (translationCount || 0),
            processed: processedCount || 0
        });
        
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ 
            error: error.message,
            linguisticFeatures: 0,
            translationAids: 0,
            total: 0,
            processed: 0
        });
    }
});

// Test route for debugging
router.get('/test-save', async (req, res) => {
    try {
        // Test with a simple entry
        const testEntry = {
            halunder_term: 'test_term',
            german_equivalent: 'test_german',
            explanation: 'test explanation',
            feature_type: 'general',
            source_table: 'linguistic_features',
            source_ids: ['123e4567-e89b-12d3-a456-426614174000']
        };
        
        console.log('Attempting to insert:', testEntry);
        
        const { data, error } = await supabase
            .from('cleaned_linguistic_examples')
            .insert([testEntry])
            .select()
            .single();
            
        if (error) {
            console.error('Detailed error:', error);
            return res.json({ 
                success: false, 
                error: error,
                errorMessage: error.message,
                errorDetails: error.details,
                errorHint: error.hint,
                errorCode: error.code
            });
        }
        
        res.json({ success: true, data });
        
    } catch (error) {
        console.error('Catch error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: error.stack 
        });
    }
});

// Test what columns exist in the table
router.get('/test-table', async (req, res) => {
    try {
        // Get table schema
        const { data, error } = await supabase
            .from('cleaned_linguistic_examples')
            .select('*')
            .limit(1);
            
        if (error) {
            return res.json({ error });
        }
        
        res.json({ 
            sampleData: data,
            message: 'Check if columns match what we are trying to insert'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start cleaning process
router.post('/start-cleaning', async (req, res) => {
    try {
        if (!supabase) {
            return res.status(400).json({ 
                error: 'Database not configured. Please add SOURCE_SUPABASE_URL and SOURCE_SUPABASE_ANON_KEY to environment variables.' 
            });
        }
        
        if (processingState.isProcessing) {
            return res.status(400).json({ error: 'Processing already in progress' });
        }
        
        const { processLinguistic, processTranslation, batchSize } = req.body;
        
        // Reset state
        processingState = {
            isProcessing: true,
            progress: 0,
            status: 'Starting...',
            details: '',
            logs: [],
            results: null,
            startTime: Date.now()
        };
        
        // Clear previous session data
        currentMergedMap = null;
        
        // Start processing in background
        processDataV2(processLinguistic, processTranslation, batchSize || 250)
            .catch(error => {
                console.error('Background processing error:', error);
                addLog(`Critical error: ${error.message}`, 'error');
                processingState.status = 'Error';
                processingState.details = error.message;
                processingState.isProcessing = false;
            });
        
        res.json({ success: true, message: 'Processing started' });
        
    } catch (error) {
        console.error('Start cleaning error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get progress
router.get('/progress', (req, res) => {
    const percentage = Math.round(processingState.progress * 100);
    const completed = !processingState.isProcessing && processingState.results !== null;
    
    res.json({
        percentage,
        status: processingState.status,
        details: processingState.details,
        logs: processingState.logs.slice(-50),
        completed,
        results: processingState.results
    });
});

// Main processing function V2
async function processDataV2(processLinguistic, processTranslation, batchSize) {
    try {
        addLog('Starting data cleaning process V2', 'info');
        
        // Step 1: Fetch all data
        let allRecords = [];
        
        if (processLinguistic) {
            addLog('Fetching linguistic features...', 'info');
            const { data: linguisticData, error } = await supabase
                .from('linguistic_features')
                .select('*')
                .order('halunder_term');
                
            if (error) throw error;
            
            allRecords = allRecords.concat(linguisticData.map(item => ({
                ...item,
                source_table: 'linguistic_features',
                term: item.halunder_term?.toLowerCase().trim()
            })));
            
            addLog(`Fetched ${linguisticData.length} linguistic features`, 'success');
        }
        
        if (processTranslation) {
            addLog('Fetching translation aids...', 'info');
            const { data: translationData, error } = await supabase
                .from('translation_aids')
                .select('*')
                .order('term');
                
            if (error) throw error;
            
            allRecords = allRecords.concat(translationData.map(item => ({
                ...item,
                halunder_term: item.term,
                source_table: 'translation_aids',
                term: item.term?.toLowerCase().trim()
            })));
            
            addLog(`Fetched ${translationData.length} translation aids`, 'success');
        }
        
        addLog(`Total records fetched: ${allRecords.length}`, 'info');
        processingState.progress = 0.2;
        
        // Step 2: Simple merge by exact term match
        processingState.status = 'Merging duplicates...';
        const mergedMap = new Map();
        
        for (const record of allRecords) {
            if (!record.term) continue;
            
            if (mergedMap.has(record.term)) {
                // Append explanation with separator
                const existing = mergedMap.get(record.term);
                existing.explanations.push(record.explanation);
                existing.source_ids.push(record.id);
                existing.source_tables.push(record.source_table);
            } else {
                // Create new entry
                mergedMap.set(record.term, {
                    halunder_term: record.halunder_term,
                    german_equivalent: record.german_equivalent || null,
                    explanations: [record.explanation],
                    feature_type: record.feature_type || 'general',
                    source_ids: [record.id],
                    source_tables: [record.source_table],
                    original_count: 1
                });
            }
        }
        
        // Store merged map globally for this session
        currentMergedMap = mergedMap;
        
        addLog(`Merged into ${mergedMap.size} unique terms`, 'info');
        processingState.progress = 0.4;
        
        // Calculate statistics
        let totalDuplicates = 0;
        for (const [term, data] of mergedMap) {
            if (data.explanations.length > 1) {
                totalDuplicates += data.explanations.length - 1;
            }
        }
        addLog(`Found ${totalDuplicates} duplicates`, 'info');
        
        // Step 3: Prepare data for LLM processing
        processingState.status = 'Preparing for LLM processing...';
        const mergedEntries = Array.from(mergedMap.entries()).map(([term, entry]) => ({
            original_term_key: term, // Keep the lowercase key for lookup
            halunder_term: entry.halunder_term,
            german_equivalent: entry.german_equivalent,
            merged_explanation: entry.explanations.join(' ++ '),
            feature_type: entry.feature_type,
            duplicate_count: entry.explanations.length
        }));
        
        processingState.progress = 0.5;
        
        // Step 4: Process with LLM in batches
        processingState.status = 'Processing with Gemini 2.5 Pro...';
        const processedEntries = [];
        const totalBatches = Math.ceil(mergedEntries.length / batchSize);
        let successfulBatches = 0;
        let failedBatches = 0;
        
        for (let i = 0; i < mergedEntries.length; i += batchSize) {
            const batch = mergedEntries.slice(i, Math.min(i + batchSize, mergedEntries.length));
            const batchNum = Math.floor(i / batchSize) + 1;
            
            processingState.status = `Processing batch ${batchNum} of ${totalBatches}`;
            processingState.details = `Processing entries ${i + 1} to ${Math.min(i + batchSize, mergedEntries.length)}`;
            processingState.progress = 0.5 + (0.4 * (i / mergedEntries.length));
            
            addLog(`Processing batch ${batchNum}/${totalBatches} (${batch.length} entries)`, 'info');
            
            try {
                const cleanedBatch = await processWithGemini(batch);
                if (cleanedBatch && cleanedBatch.length > 0) {
                    // Add original term keys to the cleaned entries
                    for (const cleanedEntry of cleanedBatch) {
                        // Find the original entry in the batch
                        const originalEntry = batch.find(b => 
                            b.halunder_term === cleanedEntry.halunder_term ||
                            b.halunder_term?.toLowerCase() === cleanedEntry.halunder_term?.toLowerCase()
                        );
                        if (originalEntry) {
                            cleanedEntry.original_term_key = originalEntry.original_term_key;
                        }
                    }
                    processedEntries.push(...cleanedBatch);
                    successfulBatches++;
                } else {
                    failedBatches++;
                    addLog(`Batch ${batchNum} returned no results`, 'warning');
                }
                
                // Add delay to respect rate limits
                await new Promise(resolve => setTimeout(resolve, 6000));
                
            } catch (error) {
                failedBatches++;
                addLog(`Error processing batch ${batchNum}: ${error.message}`, 'error');
            }
        }
        
        addLog(`Batch processing complete: ${successfulBatches} successful, ${failedBatches} failed`, 'info');
        processingState.progress = 0.9;
        
        // Step 5: Save to database
        processingState.status = 'Saving to database...';
        const results = {
            totalProcessed: allRecords.length,
            uniqueTerms: mergedMap.size,
            duplicatesFound: totalDuplicates,
            entriesCreated: 0,
            errors: 0
        };
        
        // Save all processed entries
        for (const entry of processedEntries) {
            try {
                await saveCleanedEntry(entry);
                results.entriesCreated++;
            } catch (error) {
                addLog(`Error saving entry ${entry.halunder_term}: ${error.message}`, 'error');
                results.errors++;
            }
        }
        
        // Calculate processing time
        const processingTime = Math.round((Date.now() - processingState.startTime) / 1000);
        results.processingTime = `${Math.floor(processingTime / 60)}m ${processingTime % 60}s`;
        
        processingState.results = results;
        processingState.status = 'Completed';
        processingState.details = `Created ${results.entriesCreated} entries from ${results.uniqueTerms} unique terms`;
        processingState.progress = 1;
        
        addLog('Processing completed successfully', 'success');
        
    } catch (error) {
        addLog(`Critical error: ${error.message}`, 'error');
        processingState.status = 'Error';
        processingState.details = error.message;
        throw error;
    } finally {
        processingState.isProcessing = false;
        currentMergedMap = null; // Clear the session data
    }
}

// Process batch with Gemini
async function processWithGemini(batch) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    
    const prompt = `Du bist ein Experte für die Halunder Sprache (Helgoländisch) und sollst linguistische Erklärungen für ein Wörterbuch aufbereiten.

Aufgabe:
1. Bereinige die zusammengeführten Erklärungen
2. Erstelle präzise, faktische Erklärungen die Übersetzern helfen
3. Identifiziere Hauptschreibweisen und Varianten
4. Füge kulturellen/historischen Kontext hinzu wo relevant

Wichtig:
- KEINE generischen Phrasen wie "traditionell auf Helgoland verwendet"
- NUR konkrete, nachprüfbare Fakten
- Bei Varianten: Markiere die Hauptform als "primary", Nebenformen als "secondary"
- Behalte alle wichtigen Informationen aus den Originaltexten
- WICHTIG: Escape alle Anführungszeichen in den Texten mit Backslash

Eingabe (${batch.length} Einträge):
${JSON.stringify(batch.map(({ original_term_key, ...rest }) => rest), null, 2)}

Ausgabe als JSON-Array mit dieser Struktur:
[
  {
    "halunder_term": "Hauptschreibweise",
    "german_equivalent": "Deutsche Entsprechung",
    "explanation": "Bereinigte, vollständige Erklärung",
    "feature_type": "primary|secondary|general",
    "related_to": "Hauptterm bei secondary entries"
  }
]

WICHTIG: Gib NUR das JSON-Array zurück, keine zusätzlichen Erklärungen!`;

    try {
        const result = await model.generateContent(prompt);
        let response = result.response.text();
        
        // Clean up the response
        response = response.trim();
        
        // Remove markdown code blocks if present
        response = response.replace(/```json\s*/gi, '');
        response = response.replace(/```\s*/gi, '');
        
        // Try to extract JSON array
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            throw new Error('No JSON array found in response');
        }
        
        let jsonString = jsonMatch[0];
        
        // Try to parse
        try {
            return JSON.parse(jsonString);
        } catch (parseError) {
            // If parsing fails, try to fix common issues
            addLog(`Initial JSON parse failed, attempting to fix...`, 'warning');
            
            // Log the error position
            const errorPos = parseError.message.match(/position (\d+)/)?.[1];
            if (errorPos) {
                const start = Math.max(0, parseInt(errorPos) - 100);
                const end = Math.min(jsonString.length, parseInt(errorPos) + 100);
                console.error('JSON error near:', jsonString.substring(start, end));
            }
            
            // Try one more time with a more lenient approach
            try {
                // Remove any control characters
                jsonString = jsonString.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
                return JSON.parse(jsonString);
            } catch (secondError) {
                // If it still fails, return empty array for this batch
                addLog(`Failed to parse batch, skipping: ${secondError.message}`, 'error');
                return [];
            }
        }
        
    } catch (error) {
        if (error.message?.includes('quota')) {
            throw new Error('Gemini API quota exceeded. Please wait before retrying.');
        }
        addLog(`Gemini API error: ${error.message}`, 'error');
        // Return empty array to continue processing other batches
        return [];
    }
}

// Save cleaned entry to database - FIXED VERSION
async function saveCleanedEntry(entry) {
    try {
        // Get original data using the key
        let originalData = null;
        
        if (entry.original_term_key && currentMergedMap) {
            originalData = currentMergedMap.get(entry.original_term_key);
        }
        
        // If not found by key, try to find by term
        if (!originalData && currentMergedMap) {
            const searchTerm = entry.halunder_term?.toLowerCase().trim();
            originalData = currentMergedMap.get(searchTerm);
        }
        
        if (!originalData) {
            addLog(`No original data found for ${entry.halunder_term}`, 'warning');
            return;
        }
        
        // Ensure source_ids are valid UUIDs
        const validSourceIds = originalData.source_ids.filter(id => {
            // Basic UUID validation
            return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        });
        
        const insertData = {
            halunder_term: entry.halunder_term || '',
            german_equivalent: entry.german_equivalent || null,
            explanation: entry.explanation || '',
            feature_type: entry.feature_type || 'general',
            source_table: originalData.source_tables?.[0] || 'mixed',
            source_ids: validSourceIds.length > 0 ? validSourceIds : null
        };
        
        console.log('Inserting:', JSON.stringify(insertData, null, 2));
        
        const { data, error } = await supabase
            .from('cleaned_linguistic_examples')
            .insert([insertData])
            .select()
            .single();
            
        if (error) {
            console.error('Supabase detailed error:', {
                message: error.message,
                details: error.details,
                hint: error.hint,
                code: error.code
            });
            throw new Error(error.message || 'Insert failed');
        }
        
        // Only insert mappings if we have valid IDs
        if (validSourceIds.length > 0) {
            const mappings = validSourceIds.map((sourceId, index) => ({
                original_id: sourceId,
                source_table: originalData.source_tables?.[index] || originalData.source_tables?.[0] || 'unknown',
                cleaned_id: data.id,
                similarity_score: 1.0
            }));
            
            const { error: mappingError } = await supabase
                .from('linguistic_duplicates_map')
                .insert(mappings);
                
            if (mappingError) {
                console.error('Mapping insert error:', mappingError);
                // Don't throw here, main record was saved
            }
        }
    } catch (error) {
        console.error('Save error details:', error);
        throw error;
    }
}

module.exports = router;
