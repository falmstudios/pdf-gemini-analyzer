const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const stringSimilarity = require('string-similarity');

// Initialize connections with error checking
console.log('Initializing linguistic routes...');
console.log('SOURCE_SUPABASE_URL exists:', !!process.env.SOURCE_SUPABASE_URL);
console.log('SOURCE_SUPABASE_ANON_KEY exists:', !!process.env.SOURCE_SUPABASE_ANON_KEY);
console.log('SUPABASE_URL exists:', !!process.env.SUPABASE_URL);
console.log('SUPABASE_ANON_KEY exists:', !!process.env.SUPABASE_ANON_KEY);
console.log('GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);

// Check if we have the required environment variables
if (!process.env.SOURCE_SUPABASE_URL || !process.env.SOURCE_SUPABASE_ANON_KEY) {
    console.error('WARNING: Source Supabase credentials not found!');
}

const sourceSupabase = process.env.SOURCE_SUPABASE_URL && process.env.SOURCE_SUPABASE_ANON_KEY
    ? createClient(
        process.env.SOURCE_SUPABASE_URL,
        process.env.SOURCE_SUPABASE_ANON_KEY
    )
    : null;

const destSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

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
        console.log('Getting statistics...');
        
        // Check if source database is configured
        if (!sourceSupabase) {
            console.log('Source Supabase not configured, returning mock data');
            return res.json({
                linguisticFeatures: 0,
                translationAids: 0,
                total: 0,
                processed: 0,
                error: 'Source database not configured'
            });
        }
        
        // Get counts from source database
        console.log('Fetching linguistic_features count...');
        const { count: linguisticCount, error: linguisticError } = await sourceSupabase
            .from('linguistic_features')
            .select('*', { count: 'exact', head: true });
            
        if (linguisticError) {
            console.error('Error fetching linguistic_features:', linguisticError);
        }
            
        console.log('Fetching translation_aids count...');
        const { count: translationCount, error: translationError } = await sourceSupabase
            .from('translation_aids')
            .select('*', { count: 'exact', head: true });
            
        if (translationError) {
            console.error('Error fetching translation_aids:', translationError);
        }
            
        // Get processed count from destination database
        console.log('Fetching cleaned count...');
        const { count: processedCount, error: processedError } = await destSupabase
            .from('cleaned_linguistic_examples')
            .select('*', { count: 'exact', head: true });
            
        if (processedError) {
            console.error('Error fetching cleaned_linguistic_examples:', processedError);
        }
        
        const response = {
            linguisticFeatures: linguisticCount || 0,
            translationAids: translationCount || 0,
            total: (linguisticCount || 0) + (translationCount || 0),
            processed: processedCount || 0
        };
        
        console.log('Statistics response:', response);
        res.json(response);
        
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

// Start cleaning process
router.post('/start-cleaning', async (req, res) => {
    try {
        console.log('Start cleaning request received:', req.body);
        
        if (!sourceSupabase) {
            return res.status(400).json({ 
                error: 'Source database not configured. Please add SOURCE_SUPABASE_URL and SOURCE_SUPABASE_ANON_KEY to environment variables.' 
            });
        }
        
        if (processingState.isProcessing) {
            return res.status(400).json({ error: 'Processing already in progress' });
        }
        
        const { processLinguistic, processTranslation, batchSize } = req.body;
        
        // Validate input
        if (!processLinguistic && !processTranslation) {
            return res.status(400).json({ error: 'No data sources selected for processing' });
        }
        
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
        
        // Start processing in background
        processData(processLinguistic, processTranslation, batchSize || 250)
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
        logs: processingState.logs.slice(-50), // Send only last 50 logs
        completed,
        results: processingState.results
    });
});

// Main processing function
async function processData(processLinguistic, processTranslation, batchSize) {
    try {
        addLog('Starting data cleaning process', 'info');
        addLog(`Batch size: ${batchSize}`, 'info');
        
        let allRecords = [];
        let totalRecords = 0;
        
        // Fetch linguistic features
        if (processLinguistic) {
            addLog('Fetching linguistic features...', 'info');
            try {
                const { data: linguisticData, error } = await sourceSupabase
                    .from('linguistic_features')
                    .select('*');
                    
                if (error) {
                    addLog(`Error fetching linguistic features: ${error.message}`, 'error');
                    throw error;
                }
                
                if (!linguisticData) {
                    addLog('No linguistic features data returned', 'warning');
                } else {
                    const mappedData = linguisticData.map(item => ({
                        ...item,
                        source_table: 'linguistic_features',
                        term: item.halunder_term
                    }));
                    
                    allRecords = allRecords.concat(mappedData);
                    addLog(`Fetched ${linguisticData.length} linguistic features`, 'success');
                }
            } catch (error) {
                addLog(`Failed to fetch linguistic features: ${error.message}`, 'error');
                if (!processTranslation) throw error; // Only throw if not processing translation aids
            }
        }
        
        // Fetch translation aids
        if (processTranslation) {
            addLog('Fetching translation aids...', 'info');
            try {
                const { data: translationData, error } = await sourceSupabase
                    .from('translation_aids')
                    .select('*');
                    
                if (error) {
                    addLog(`Error fetching translation aids: ${error.message}`, 'error');
                    throw error;
                }
                
                if (!translationData) {
                    addLog('No translation aids data returned', 'warning');
                } else {
                    const mappedData = translationData.map(item => ({
                        id: item.id,
                        halunder_term: item.term,
                        german_equivalent: null,
                        explanation: item.explanation,
                        feature_type: 'translation_aid',
                        source_table: 'translation_aids',
                        term: item.term
                    }));
                    
                    allRecords = allRecords.concat(mappedData);
                    addLog(`Fetched ${translationData.length} translation aids`, 'success');
                }
            } catch (error) {
                addLog(`Failed to fetch translation aids: ${error.message}`, 'error');
                if (!processLinguistic || allRecords.length === 0) throw error;
            }
        }
        
        totalRecords = allRecords.length;
        
        if (totalRecords === 0) {
            throw new Error('No records found to process');
        }
        
        addLog(`Total records to process: ${totalRecords}`, 'info');
        
        // Group similar entries
        processingState.status = 'Finding duplicates...';
        const groups = findSimilarEntries(allRecords);
        addLog(`Found ${groups.length} unique groups`, 'info');
        
        // Process in batches
        const results = {
            totalProcessed: 0,
            uniqueEntries: 0,
            duplicatesFound: 0,
            errors: 0
        };
        
        for (let i = 0; i < groups.length; i += batchSize) {
            const batch = groups.slice(i, Math.min(i + batchSize, groups.length));
            const batchNum = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(groups.length / batchSize);
            
            processingState.status = `Processing batch ${batchNum} of ${totalBatches}`;
            processingState.details = `Processing entries ${i + 1} to ${Math.min(i + batchSize, groups.length)} of ${groups.length}`;
            processingState.progress = (i + batch.length) / groups.length;
            
            addLog(`Processing batch ${batchNum}/${totalBatches}`, 'info');
            
            try {
                // Process this batch with Gemini
                const processedBatch = await processBatchWithGemini(batch);
                
                // Save to database
                for (const entry of processedBatch) {
                    try {
                        await saveCleanedEntry(entry);
                        results.uniqueEntries++;
                        results.duplicatesFound += entry.sourceIds.length - 1;
                        results.totalProcessed += entry.sourceIds.length;
                    } catch (error) {
                        addLog(`Error saving entry: ${error.message}`, 'error');
                        results.errors++;
                    }
                }
            } catch (error) {
                addLog(`Error processing batch ${batchNum}: ${error.message}`, 'error');
                results.errors += batch.length;
            }
            
            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Calculate processing time
        const processingTime = Math.round((Date.now() - processingState.startTime) / 1000);
        results.processingTime = `${Math.floor(processingTime / 60)}m ${processingTime % 60}s`;
        
        processingState.results = results;
        processingState.status = 'Completed';
        processingState.details = `Processed ${results.totalProcessed} records, created ${results.uniqueEntries} unique entries`;
        processingState.progress = 1;
        
        addLog('Processing completed successfully', 'success');
        
    } catch (error) {
        addLog(`Critical error: ${error.message}`, 'error');
        processingState.status = 'Error';
        processingState.details = error.message;
        throw error;
    } finally {
        processingState.isProcessing = false;
    }
}

// Find similar entries
function findSimilarEntries(records) {
    const groups = [];
    const processed = new Set();
    
    for (let i = 0; i < records.length; i++) {
        if (processed.has(i)) continue;
        
        const group = [records[i]];
        processed.add(i);
        
        for (let j = i + 1; j < records.length; j++) {
            if (processed.has(j)) continue;
            
            if (areSimilar(records[i], records[j])) {
                group.push(records[j]);
                processed.add(j);
            }
        }
        
        groups.push(group);
    }
    
    return groups;
}

// Check if two entries are similar
function areSimilar(entry1, entry2) {
    const term1 = (entry1.term || '').toLowerCase().trim();
    const term2 = (entry2.term || '').toLowerCase().trim();
    
    // Exact match
    if (term1 === term2) return true;
    
    // Check if one is subset of another (e.g., "Hog" and "Hog/Pig")
    if (term1.includes(term2) || term2.includes(term1)) {
        // Make sure it's a meaningful subset (not just partial word match)
        const separators = [' ', '/', ',', ';', '(', ')'];
        for (const sep of separators) {
            if (term1.split(sep).includes(term2) || term2.split(sep).includes(term1)) {
                return true;
            }
        }
    }
    
    // Check explanation similarity (only if terms are somewhat similar)
    const termSimilarity = stringSimilarity.compareTwoStrings(term1, term2);
    if (termSimilarity > 0.8) {
        const exp1 = (entry1.explanation || '').toLowerCase();
        const exp2 = (entry2.explanation || '').toLowerCase();
        const expSimilarity = stringSimilarity.compareTwoStrings(exp1, exp2);
        return expSimilarity > 0.7;
    }
    
    return false;
}

// Process batch with Gemini
async function processBatchWithGemini(groups) {
    const processed = [];
    
    for (const group of groups) {
        if (group.length === 1) {
            // Single entry, no need for Gemini
            processed.push({
                halunder_term: group[0].halunder_term || group[0].term,
                german_equivalent: group[0].german_equivalent,
                explanation: group[0].explanation,
                feature_type: group[0].feature_type,
                source_table: group[0].source_table,
                sourceIds: [group[0].id]
            });
        } else {
            // Multiple entries, use Gemini to consolidate
            try {
                const consolidated = await consolidateWithGemini(group);
                processed.push({
                    ...consolidated,
                    sourceIds: group.map(g => g.id)
                });
            } catch (error) {
                addLog(`Error consolidating group: ${error.message}`, 'warning');
                // Fallback: use the most complete entry
                const best = group.reduce((a, b) => 
                    (a.explanation || '').length > (b.explanation || '').length ? a : b
                );
                processed.push({
                    halunder_term: best.halunder_term || best.term,
                    german_equivalent: best.german_equivalent,
                    explanation: best.explanation,
                    feature_type: best.feature_type,
                    source_table: best.source_table,
                    sourceIds: group.map(g => g.id)
                });
            }
        }
    }
    
    return processed;
}

// Consolidate entries with Gemini
async function consolidateWithGemini(group) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    
    const prompt = `You are a linguistic expert consolidating duplicate dictionary entries. 
Analyze these similar entries and create ONE consolidated entry that combines the best information from all:

${group.map((g, i) => `Entry ${i + 1}:
- Term: ${g.halunder_term || g.term}
- German: ${g.german_equivalent || 'N/A'}
- Explanation: ${g.explanation}
- Type: ${g.feature_type || 'N/A'}`).join('\n\n')}

Create a single consolidated entry with:
1. The most complete/correct Halunder term
2. The German equivalent (if available)
3. A comprehensive explanation combining all useful information
4. The most appropriate feature type

Respond in JSON format:
{
    "halunder_term": "...",
    "german_equivalent": "...",
    "explanation": "...",
    "feature_type": "..."
}`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
            ...parsed,
            source_table: group[0].source_table // Keep original source table
        };
    }
    
    throw new Error('Failed to parse Gemini response');
}

// Save cleaned entry to database
async function saveCleanedEntry(entry) {
    // Insert the cleaned entry
    const { data: cleanedData, error: cleanedError } = await destSupabase
        .from('cleaned_linguistic_examples')
        .insert([{
            halunder_term: entry.halunder_term,
            german_equivalent: entry.german_equivalent,
            explanation: entry.explanation,
            feature_type: entry.feature_type,
            source_table: entry.source_table,
            source_ids: entry.sourceIds
        }])
        .select()
        .single();
        
    if (cleanedError) throw cleanedError;
    
    // Insert duplicate mappings
    const mappings = entry.sourceIds.map(sourceId => ({
        original_id: sourceId,
        source_table: entry.source_table,
        cleaned_id: cleanedData.id,
        similarity_score: 1.0
    }));
    
    const { error: mappingError } = await destSupabase
        .from('linguistic_duplicates_map')
        .insert(mappings);
        
    if (mappingError) throw mappingError;
}

module.exports = router;
