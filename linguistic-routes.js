const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Add body parser middleware to this router
router.use(express.json());

// Initialize connections with error checking
console.log('Initializing linguistic routes v4 with relevance and tags...');
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

// Helper function to fetch all records with pagination
async function fetchAllRecords(tableName, orderColumn) {
    const pageSize = 1000;
    let allRecords = [];
    let page = 0;
    let hasMore = true;
    
    while (hasMore) {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        
        const { data, error, count } = await supabase
            .from(tableName)
            .select('*', { count: 'exact' })
            .order(orderColumn)
            .range(from, to);
            
        if (error) throw error;
        
        if (data && data.length > 0) {
            allRecords = allRecords.concat(data);
            addLog(`Fetched ${data.length} records from ${tableName} (page ${page + 1})`, 'info');
        }
        
        hasMore = data && data.length === pageSize;
        page++;
    }
    
    return allRecords;
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
        // Test with a simple entry including new fields
        const testEntry = {
            halunder_term: 'test_term_' + Date.now(),
            german_equivalent: 'test_german',
            explanation: 'test explanation',
            feature_type: 'general',
            source_table: 'linguistic_features',
            source_ids: ['123e4567-e89b-12d3-a456-426614174000'],
            relevance_score: 5,
            tags: ['test', 'debug']
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

// Check which terms are already processed
async function getProcessedTerms() {
    try {
        const { data, error } = await supabase
            .from('cleaned_linguistic_examples')
            .select('halunder_term');
            
        if (error) throw error;
        
        // Create a Set of processed terms (lowercase for comparison)
        const processedSet = new Set();
        if (data) {
            data.forEach(item => {
                if (item.halunder_term) {
                    processedSet.add(item.halunder_term.toLowerCase().trim());
                }
            });
        }
        
        return processedSet;
    } catch (error) {
        addLog(`Error fetching processed terms: ${error.message}`, 'warning');
        return new Set();
    }
}

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
        processDataV4(processLinguistic, processTranslation, batchSize || 100) // Smaller batches for more complex processing
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

// Main processing function V4 - With relevance and tags
async function processDataV4(processLinguistic, processTranslation, batchSize) {
    try {
        addLog('Starting data cleaning process V4 with relevance scoring and tags', 'info');
        
        // Get already processed terms
        processingState.status = 'Checking already processed terms...';
        const processedTerms = await getProcessedTerms();
        addLog(`Found ${processedTerms.size} already processed terms`, 'info');
        
        // Step 1: Fetch all data with pagination
        let allRecords = [];
        
        if (processLinguistic) {
            addLog('Fetching ALL linguistic features with pagination...', 'info');
            const linguisticData = await fetchAllRecords('linguistic_features', 'halunder_term');
            
            allRecords = allRecords.concat(linguisticData.map(item => ({
                ...item,
                source_table: 'linguistic_features',
                term: item.halunder_term?.toLowerCase().trim()
            })));
            
            addLog(`Fetched total ${linguisticData.length} linguistic features`, 'success');
        }
        
        if (processTranslation) {
            addLog('Fetching ALL translation aids with pagination...', 'info');
            const translationData = await fetchAllRecords('translation_aids', 'term');
            
            allRecords = allRecords.concat(translationData.map(item => ({
                ...item,
                halunder_term: item.term,
                source_table: 'translation_aids',
                term: item.term?.toLowerCase().trim()
            })));
            
            addLog(`Fetched total ${translationData.length} translation aids`, 'success');
        }
        
        addLog(`Total records fetched: ${allRecords.length}`, 'info');
        processingState.progress = 0.2;
        
        // Step 2: Filter out already processed terms and merge duplicates
        processingState.status = 'Merging duplicates and filtering processed terms...';
        const mergedMap = new Map();
        let skippedCount = 0;
        
        for (const record of allRecords) {
            if (!record.term) continue;
            
            // Skip if already processed
            if (processedTerms.has(record.term)) {
                skippedCount++;
                continue;
            }
            
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
        
        addLog(`Skipped ${skippedCount} already processed records`, 'info');
        addLog(`Merged into ${mergedMap.size} unique unprocessed terms`, 'info');
        processingState.progress = 0.4;
        
        // Calculate statistics
        let totalDuplicates = 0;
        for (const [term, data] of mergedMap) {
            if (data.explanations.length > 1) {
                totalDuplicates += data.explanations.length - 1;
            }
        }
        addLog(`Found ${totalDuplicates} duplicates in unprocessed data`, 'info');
        
        // If no unprocessed terms, exit early
        if (mergedMap.size === 0) {
            processingState.results = {
                totalProcessed: 0,
                uniqueTerms: 0,
                duplicatesFound: 0,
                entriesCreated: 0,
                errors: 0,
                processingTime: '0m 0s',
                message: 'All terms have already been processed'
            };
            processingState.status = 'Completed';
            processingState.progress = 1;
            addLog('No new terms to process', 'info');
            return;
        }
        
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
                const cleanedBatch = await processWithGeminiV4(batch);
                if (cleanedBatch && cleanedBatch.length > 0) {
                    // Add original term keys to the cleaned entries
                    for (const cleanedEntry of cleanedBatch) {
                        // Find the original entry in the batch by matching halunder_term
                        const originalEntry = batch.find(b => {
                            const bTerm = b.halunder_term?.toLowerCase().trim();
                            const cTerm = cleanedEntry.halunder_term?.toLowerCase().trim();
                            return bTerm === cTerm;
                        });
                        
                        if (originalEntry) {
                            cleanedEntry.original_term_key = originalEntry.original_term_key;
                        } else {
                            // If exact match fails, try to find by the key directly
                            const termKey = cleanedEntry.halunder_term?.toLowerCase().trim();
                            if (currentMergedMap.has(termKey)) {
                                cleanedEntry.original_term_key = termKey;
                            }
                        }
                    }
                    processedEntries.push(...cleanedBatch);
                    successfulBatches++;
                } else {
                    failedBatches++;
                    addLog(`Batch ${batchNum} returned no results`, 'warning');
                }
                
                // Add delay to respect rate limits
                await new Promise(resolve => setTimeout(resolve, 8000)); // Slightly longer delay for more complex processing
                
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
            skippedAlreadyProcessed: skippedCount,
            uniqueTerms: mergedMap.size,
            duplicatesFound: totalDuplicates,
            entriesCreated: 0,
            errors: 0
        };
        
        // Save all processed entries
        for (const entry of processedEntries) {
            try {
                await saveCleanedEntryV4(entry);
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
        processingState.details = `Created ${results.entriesCreated} entries from ${results.uniqueTerms} unique unprocessed terms`;
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

// Process batch with Gemini V4 - With relevance and tags
async function processWithGeminiV4(batch) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
        
        const prompt = `Analysiere diese Helgoländischen Wörter, Satzteile oder Phrasen. Sie sollen als Hilfsstellung für einen Übersetzer dienen, sodass der Benutzer bei bestimmten Wörtern oder fixen konstruktionen ein Highlight sieht mit einer kleinen interessanten Erklärung. Für jeden Eintrag:
1. Bereinige die Erklärung, insbesondere bei Duplikaten, Redundanzen, etc. Behalte immer das interessanteste. Denk nach was jemand lesen wollen würde und was für lernen und Verständnis besonders hilfreich wäre.
2. Bewerte die Relevanz (0-10): Kulturelle Bedeutung, unerwartete Bedeutungen, reichhaltige Informationen = hoch. Einfache Erklärungen wie "der Plural von X" oder direkte Übersetzungen = niedrig
3. Vergib passende Tags aus: cultural, idiom, grammar, false_friend, misspelling, etymology, person, place, building, date, maritime, food, tradition, archaic

Du sollst bereinigen und die optimale und vielfältigste Erklärung (bis zu mehreren Sätzen) erstellen.

In a sense that these translation aids / linguistic explanations help the user of a translator / dictionary to understand why a certain word is used.

Easy example:
Heligolands main sight/attraction is the "Lange Anna" in german. When translating to Halunder, that becomes "Nathurnstak" or "Nathurn Stak". Therefore that word (or both words) should receive a full explanation in a few sentences. No generic bullshit, just straight up facts. For example: Nathurnstak (term) would have the following explanation: Das Wahrzeichen Helgolands ist die Lange Anna, welche auf Halunder "Nathurnstak" oder älter "Nathurn Stak" heißt. Die Bezeichnung Lange Anna ist auf eine Bedienung in einem Café an der Nordspitze zurückzuführen, auf Helgoländisch wurde diese aber nicht übernommen. Das Nathurnstak entstand, als das vorgelagerte Nathurn Gatt" im Jahr XXXX ins Meer abgebrochen ist. Die Lange Anna wurde XXXX mit einem Betonfuß verstärkt.

So you should generate two clean entries for either Nathurnstak (primary, the correct form) and all other "correct" spellings or synonyms as "secondary" tag with the same explanation.

Eingabe: ${batch.length} Einträge
${JSON.stringify(batch.map(({ original_term_key, ...rest }) => rest), null, 2)}

Ausgabe als JSON-Array:
[{
  "halunder_term": "EXAKT wie im Input",
  "german_equivalent": "deutsche Übersetzung",
  "explanation": "bereinigte Erklärung",
  "feature_type": "primary/secondary",
  "relevance_score": 5,
  "tags": ["cultural", "place"]
}]

NUR das JSON-Array zurückgeben!`;

        const result = await model.generateContent(prompt);
        let response = result.response.text();
        
        // Log first 500 chars of response for debugging
        console.log('Gemini response start:', response.substring(0, 500));
        
        // Clean up the response
        response = response.trim();
        
        // Remove markdown code blocks if present
        response = response.replace(/```json\s*/gi, '');
        response = response.replace(/```\s*/gi, '');
        
        // Try to find JSON array in the response
        const arrayStart = response.indexOf('[');
        const arrayEnd = response.lastIndexOf(']');
        
        if (arrayStart === -1 || arrayEnd === -1 || arrayStart >= arrayEnd) {
            console.error('No valid array found in response');
            throw new Error('No JSON array found in response');
        }
        
        // Extract just the array part
        let jsonString = response.substring(arrayStart, arrayEnd + 1);
        
        try {
            const parsed = JSON.parse(jsonString);
            if (Array.isArray(parsed)) {
                // Validate and fix entries
                const validatedEntries = parsed.map(entry => {
                    // Ensure relevance_score is a number between 0-10
                    if (typeof entry.relevance_score !== 'number' || entry.relevance_score < 0 || entry.relevance_score > 10) {
                        entry.relevance_score = 5; // Default to middle value
                    }
                    // Ensure tags is an array
                    if (!Array.isArray(entry.tags)) {
                        entry.tags = [];
                    }
                    return entry;
                });
                
                addLog(`Successfully parsed ${validatedEntries.length} entries from Gemini`, 'success');
                return validatedEntries;
            } else {
                throw new Error('Parsed result is not an array');
            }
        } catch (parseError) {
            console.error('JSON parse error:', parseError.message);
            
            // Try to fix common JSON issues
            try {
                // Remove control characters and fix quotes
                jsonString = jsonString
                    .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                    .replace(/"\s*:\s*"/g, '":"')
                    .replace(/,\s*}/g, '}')
                    .replace(/,\s*]/g, ']');
                
                const parsed = JSON.parse(jsonString);
                if (Array.isArray(parsed)) {
                    addLog(`Successfully parsed ${parsed.length} entries after cleanup`, 'success');
                    return parsed;
                }
            } catch (secondError) {
                console.error('Second parse attempt failed:', secondError.message);
            }
            
            throw new Error(`Failed to parse response: ${parseError.message}`);
        }
        
    } catch (error) {
        if (error.message?.includes('quota')) {
            throw new Error('Gemini API quota exceeded. Please wait before retrying.');
        }
        console.error('Gemini processing error:', error);
        addLog(`Gemini API error: ${error.message}`, 'error');
        return [];
    }
}

// Save cleaned entry to database V4 - With relevance and tags
async function saveCleanedEntryV4(entry) {
    try {
        // Get original data using the key
        let originalData = null;
        
        if (entry.original_term_key && currentMergedMap) {
            originalData = currentMergedMap.get(entry.original_term_key);
        }
        
        // If not found by key, try to find by term (case-insensitive)
        if (!originalData && currentMergedMap && entry.halunder_term) {
            const searchTerm = entry.halunder_term.toLowerCase().trim();
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
            source_ids: validSourceIds.length > 0 ? validSourceIds : null,
            relevance_score: entry.relevance_score || 5,
            tags: entry.tags || []
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
