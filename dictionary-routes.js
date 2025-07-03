const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const Papa = require('papaparse');
const path = require('path');
const fs = require('fs').promises;

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// State management for each process
let processingStates = {
    ahrhammar: {
        isProcessing: false,
        progress: 0,
        status: 'idle',
        details: '',
        logs: [],
        results: null
    },
    krogmann: {
        isProcessing: false,
        progress: 0,
        status: 'idle',
        details: '',
        logs: [],
        results: null
    },
    csv: {
        isProcessing: false,
        progress: 0,
        status: 'idle',
        details: '',
        logs: [],
        results: null
    }
};

// Helper function to add logs
function addLog(processType, message, type = 'info') {
    const log = {
        id: Date.now() + Math.random(),
        message,
        type,
        timestamp: new Date().toISOString()
    };
    processingStates[processType].logs.push(log);
    
    // Keep only last 1000 logs
    if (processingStates[processType].logs.length > 1000) {
        processingStates[processType].logs = processingStates[processType].logs.slice(-1000);
    }
    
    console.log(`[${processType.toUpperCase()}] [${type.toUpperCase()}] ${message}`);
}

// Get statistics
router.get('/stats', async (req, res) => {
    try {
        // Count Ahrhammar entries in pdf_analyses
        const { count: ahrhammarCount } = await supabase
            .from('pdf_analyses')
            .select('*', { count: 'exact', head: true });
            
        // Count Krogmann entries
        const { count: krogmannCount } = await supabase
            .from('krogmann_uploads')
            .select('*', { count: 'exact', head: true });
            
        // Count concepts
        const { count: conceptsCount } = await supabase
            .from('concepts')
            .select('*', { count: 'exact', head: true });
            
        // Count terms
        const { count: termsCount } = await supabase
            .from('terms')
            .select('*', { count: 'exact', head: true });
        
        // For CSV count, we'll check if the file exists
        let csvCount = 0;
        try {
            const csvPath = path.join(__dirname, 'public', 'miin_iaars_duusend_wurder.csv');
            const csvContent = await fs.readFile(csvPath, 'utf8');
            const parsed = Papa.parse(csvContent, { header: true, skipEmptyLines: true });
            csvCount = parsed.data.length;
        } catch (error) {
            console.log('CSV file not found or error reading');
        }
        
        res.json({
            ahrhammarCount: ahrhammarCount || 0,
            krogmannCount: krogmannCount || 0,
            csvCount: csvCount,
            conceptsCount: conceptsCount || 0,
            termsCount: termsCount || 0
        });
        
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Upload Krogmann JSON
router.post('/upload-krogmann', async (req, res) => {
    try {
        const { filename, data } = req.body;
        
        const { error } = await supabase
            .from('krogmann_uploads')
            .insert([{
                filename: filename,
                data: data,
                processed: false
            }]);
            
        if (error) throw error;
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Process Ahrhammar data
router.post('/process-ahrhammar', async (req, res) => {
    try {
        if (processingStates.ahrhammar.isProcessing) {
            return res.status(400).json({ error: 'Ahrhammar processing already in progress' });
        }
        
        // Reset state
        processingStates.ahrhammar = {
            isProcessing: true,
            progress: 0,
            status: 'Starting...',
            details: '',
            logs: [],
            results: null,
            startTime: Date.now()
        };
        
        // Start processing in background
        processAhrhammarData().catch(error => {
            console.error('Ahrhammar processing error:', error);
            addLog('ahrhammar', `Critical error: ${error.message}`, 'error');
            processingStates.ahrhammar.status = 'Error';
            processingStates.ahrhammar.isProcessing = false;
        });
        
        res.json({ success: true, message: 'Ahrhammar processing started' });
        
    } catch (error) {
        console.error('Start processing error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Process Krogmann data
router.post('/process-krogmann', async (req, res) => {
    try {
        if (processingStates.krogmann.isProcessing) {
            return res.status(400).json({ error: 'Krogmann processing already in progress' });
        }
        
        // Reset state
        processingStates.krogmann = {
            isProcessing: true,
            progress: 0,
            status: 'Starting...',
            details: '',
            logs: [],
            results: null,
            startTime: Date.now()
        };
        
        // Start processing in background
        processKrogmannData().catch(error => {
            console.error('Krogmann processing error:', error);
            addLog('krogmann', `Critical error: ${error.message}`, 'error');
            processingStates.krogmann.status = 'Error';
            processingStates.krogmann.isProcessing = false;
        });
        
        res.json({ success: true, message: 'Krogmann processing started' });
        
    } catch (error) {
        console.error('Start processing error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Process CSV data
router.post('/process-csv', async (req, res) => {
    try {
        if (processingStates.csv.isProcessing) {
            return res.status(400).json({ error: 'CSV processing already in progress' });
        }
        
        // Reset state
        processingStates.csv = {
            isProcessing: true,
            progress: 0,
            status: 'Starting...',
            details: '',
            logs: [],
            results: null,
            startTime: Date.now()
        };
        
        // Start processing in background
        processCSVData().catch(error => {
            console.error('CSV processing error:', error);
            addLog('csv', `Critical error: ${error.message}`, 'error');
            processingStates.csv.status = 'Error';
            processingStates.csv.isProcessing = false;
        });
        
        res.json({ success: true, message: 'CSV processing started' });
        
    } catch (error) {
        console.error('Start processing error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get progress
router.get('/progress/:type', (req, res) => {
    const processType = req.params.type;
    const state = processingStates[processType];
    
    if (!state) {
        return res.status(404).json({ error: 'Invalid process type' });
    }
    
    const percentage = Math.round(state.progress * 100);
    const completed = !state.isProcessing && state.results !== null;
    
    res.json({
        percentage,
        status: state.status,
        details: state.details,
        logs: state.logs.slice(-50),
        completed,
        results: state.results
    });
});

// Main processing functions

async function processAhrhammarData() {
    const state = processingStates.ahrhammar;
    
    try {
        addLog('ahrhammar', 'Starting Ahrhammar data processing', 'info');
        
        // Fetch all PDF analyses, ordered by ID to ensure consistent processing
        state.status = 'Fetching PDF analyses...';
        const { data: pdfAnalyses, error } = await supabase
            .from('pdf_analyses')
            .select('*')
            .order('id'); // Order by ID instead of filename
            
        if (error) throw error;
        
        addLog('ahrhammar', `Found ${pdfAnalyses.length} PDF analyses to process`, 'info');
        state.progress = 0.1;
        
        const results = {
            totalProcessed: 0,
            conceptsCreated: 0,
            termsCreated: 0,
            examplesCreated: 0,
            relationsCreated: 0,
            errors: 0
        };
        
        // First pass: Create all concepts and terms
        addLog('ahrhammar', 'First pass: Creating concepts and terms...', 'info');
        const conceptsMap = new Map(); // Store headword -> concept_id mapping
        
        for (let i = 0; i < pdfAnalyses.length; i++) {
            const analysis = pdfAnalyses[i];
            state.status = `First pass: Processing ${analysis.filename}`;
            state.details = `File ${i + 1} of ${pdfAnalyses.length}`;
            state.progress = 0.1 + (0.4 * (i / pdfAnalyses.length));
            
            try {
                // Clean the JSON (remove wrapper)
                let jsonData = analysis.result;
                if (jsonData.startsWith('```json')) {
                    jsonData = jsonData.substring(7);
                }
                if (jsonData.endsWith('```')) {
                    jsonData = jsonData.substring(0, jsonData.length - 3);
                }
                
                const entries = JSON.parse(jsonData);
                
                // Process each entry (first pass - concepts only)
                for (const entry of entries) {
                    try {
                        const conceptId = await createConceptAndTerms(entry, results);
                        if (conceptId) {
                            conceptsMap.set(entry.headword, conceptId);
                        }
                        results.totalProcessed++;
                    } catch (error) {
                        addLog('ahrhammar', `Error processing entry ${entry.headword}: ${error.message}`, 'warning');
                        results.errors++;
                    }
                }
                
                addLog('ahrhammar', `First pass completed for ${analysis.filename}: ${entries.length} entries`, 'info');
                
            } catch (error) {
                addLog('ahrhammar', `Error processing ${analysis.filename}: ${error.message}`, 'error');
                results.errors++;
            }
        }
        
        // Second pass: Create relations now that all concepts exist
        addLog('ahrhammar', 'Second pass: Creating relations...', 'info');
        
        for (let i = 0; i < pdfAnalyses.length; i++) {
            const analysis = pdfAnalyses[i];
            state.status = `Second pass: Processing relations from ${analysis.filename}`;
            state.details = `File ${i + 1} of ${pdfAnalyses.length}`;
            state.progress = 0.5 + (0.4 * (i / pdfAnalyses.length));
            
            try {
                // Clean the JSON again
                let jsonData = analysis.result;
                if (jsonData.startsWith('```json')) {
                    jsonData = jsonData.substring(7);
                }
                if (jsonData.endsWith('```')) {
                    jsonData = jsonData.substring(0, jsonData.length - 3);
                }
                
                const entries = JSON.parse(jsonData);
                
                // Process relations
                for (const entry of entries) {
                    if (entry.relations && entry.relations.length > 0) {
                        const sourceConceptId = conceptsMap.get(entry.headword);
                        if (sourceConceptId) {
                            for (const relation of entry.relations) {
                                try {
                                    await createRelation(sourceConceptId, relation, conceptsMap, results);
                                } catch (error) {
                                    addLog('ahrhammar', `Error creating relation for ${entry.headword}: ${error.message}`, 'warning');
                                }
                            }
                        }
                    }
                }
                
                addLog('ahrhammar', `Second pass completed for ${analysis.filename}`, 'info');
                
            } catch (error) {
                addLog('ahrhammar', `Error in second pass for ${analysis.filename}: ${error.message}`, 'error');
            }
        }
        
        // Calculate processing time
        const processingTime = Math.round((Date.now() - state.startTime) / 1000);
        results.processingTime = `${Math.floor(processingTime / 60)}m ${processingTime % 60}s`;
        
        state.results = results;
        state.status = 'Completed';
        state.progress = 1;
        
        addLog('ahrhammar', `Processing completed: ${results.conceptsCreated} concepts, ${results.termsCreated} terms, ${results.relationsCreated} relations created`, 'success');
        
    } catch (error) {
        addLog('ahrhammar', `Critical error: ${error.message}`, 'error');
        state.status = 'Error';
        throw error;
    } finally {
        state.isProcessing = false;
    }
}

// Helper function to create concept and terms (first pass)
async function createConceptAndTerms(entry, results) {
    // Create or get concept
    const { data: concept, error: conceptError } = await supabase
        .from('concepts')
        .insert({
            primary_german_label: entry.headword,
            part_of_speech: entry.partOfSpeech,
            notes: entry.usageNotes ? entry.usageNotes.join('; ') : null
        })
        .select()
        .single();
        
    if (conceptError) {
        // Try to get existing concept
        const { data: existingConcept } = await supabase
            .from('concepts')
            .select('id')
            .eq('primary_german_label', entry.headword)
            .single();
            
        if (existingConcept) {
            return existingConcept.id;
        }
        throw conceptError;
    }
    
    results.conceptsCreated++;
    
    // Add German term
    const { data: germanTerm } = await supabase
        .from('terms')
        .insert({
            term_text: entry.headword,
            language: 'de'
        })
        .select()
        .single();
        
    if (germanTerm) {
        results.termsCreated++;
    }
    
    // Process translations
    if (entry.translations) {
        for (const translation of entry.translations) {
            // Create Halunder term
            const { data: halunderTerm } = await supabase
                .from('terms')
                .insert({
                    term_text: translation.term,
                    language: 'hal'
                })
                .select()
                .single();
                
            if (halunderTerm) {
                results.termsCreated++;
                
                // Link to concept
                await supabase
                    .from('concept_to_term')
                    .insert({
                        concept_id: concept.id,
                        term_id: halunderTerm.id,
                        pronunciation: translation.pronunciation,
                        gender: translation.gender,
                        plural_form: translation.plural,
                        etymology: translation.etymology,
                        note: translation.note,
                        source_name: 'ahrhammar'
                    });
            }
        }
    }
    
    // Process examples
    if (entry.examples) {
        for (const example of entry.examples) {
            await supabase
                .from('examples')
                .insert({
                    concept_id: concept.id,
                    halunder_sentence: example.halunder,
                    german_sentence: example.german,
                    note: example.note,
                    source_name: 'ahrhammar'
                });
            results.examplesCreated++;
        }
    }
    
    return concept.id;
}

// Helper function to create relations (second pass)
async function createRelation(sourceConceptId, relation, conceptsMap, results) {
    // Try to find target concept by German term
    let targetConceptId = conceptsMap.get(relation.targetTerm);
    
    if (!targetConceptId) {
        // Try to find in database
        const { data: targetConcept } = await supabase
            .from('concepts')
            .select('id')
            .eq('primary_german_label', relation.targetTerm)
            .single();
            
        if (targetConcept) {
            targetConceptId = targetConcept.id;
        }
    }
    
    if (targetConceptId) {
        const { error } = await supabase
            .from('relations')
            .insert({
                source_concept_id: sourceConceptId,
                target_concept_id: targetConceptId,
                relation_type: relation.type,
                note: relation.note
            });
            
        if (!error) {
            results.relationsCreated++;
        }
    } else {
        addLog('ahrhammar', `Could not find target concept for relation: ${relation.targetTerm}`, 'warning');
    }
}

async function processAhrhammarEntry(entry, results) {
    // Create or get concept
    const { data: concept, error: conceptError } = await supabase
        .from('concepts')
        .upsert({
            primary_german_label: entry.headword,
            part_of_speech: entry.partOfSpeech,
            notes: entry.usageNotes ? entry.usageNotes.join('; ') : null
        }, {
            onConflict: 'primary_german_label',
            returning: 'minimal'
        })
        .select()
        .single();
        
    if (conceptError) throw conceptError;
    
    if (concept) {
        results.conceptsCreated++;
    }
    
    // Add German term
    const { data: germanTerm } = await supabase
        .from('terms')
        .upsert({
            term_text: entry.headword,
            language: 'de'
        }, {
            onConflict: 'term_text,language'
        })
        .select()
        .single();
        
    if (germanTerm) {
        results.termsCreated++;
    }
    
    // Process translations
    if (entry.translations) {
        for (const translation of entry.translations) {
            // Create Halunder term
            const { data: halunderTerm } = await supabase
                .from('terms')
                .upsert({
                    term_text: translation.term,
                    language: 'hal'
                }, {
                    onConflict: 'term_text,language'
                })
                .select()
                .single();
                
            if (halunderTerm) {
                results.termsCreated++;
                
                // Link to concept
                await supabase
                    .from('concept_to_term')
                    .upsert({
                        concept_id: concept.id,
                        term_id: halunderTerm.id,
                        pronunciation: translation.pronunciation,
                        gender: translation.gender,
                        plural_form: translation.plural,
                        etymology: translation.etymology,
                        source_name: 'ahrhammar'
                    });
            }
        }
    }
    
    // Process examples
    if (entry.examples) {
        for (const example of entry.examples) {
            await supabase
                .from('examples')
                .insert({
                    concept_id: concept.id,
                    halunder_sentence: example.halunder,
                    german_sentence: example.german,
                    note: example.note,
                    source_name: 'ahrhammar'
                });
            results.examplesCreated++;
        }
    }
}

async function processKrogmannData() {
    const state = processingStates.krogmann;
    
    try {
        addLog('krogmann', 'Starting Krogmann data processing', 'info');
        
        // Fetch unprocessed Krogmann uploads
        state.status = 'Fetching Krogmann data...';
        const { data: krogmannData, error } = await supabase
            .from('krogmann_uploads')
            .select('*')
            .eq('processed', false)
            .order('filename');
            
        if (error) throw error;
        
        addLog('krogmann', `Found ${krogmannData.length} Krogmann files to process`, 'info');
        state.progress = 0.1;
        
        const results = {
            totalProcessed: 0,
            conceptsEnriched: 0,
            termsCreated: 0,
            examplesCreated: 0,
            errors: 0
        };
        
        // Process each Krogmann file
        for (let i = 0; i < krogmannData.length; i++) {
            const file = krogmannData[i];
            state.status = `Processing ${file.filename}`;
            state.details = `File ${i + 1} of ${krogmannData.length}`;
            state.progress = 0.1 + (0.8 * (i / krogmannData.length));
            
            try {
                const entries = file.data;
                
                // Process each entry
                for (const entry of entries) {
                    try {
                        await processKrogmannEntry(entry, results);
                        results.totalProcessed++;
                    } catch (error) {
                        addLog('krogmann', `Error processing entry ${entry.halunderWord}: ${error.message}`, 'warning');
                        results.errors++;
                    }
                }
                
                // Mark as processed
                await supabase
                    .from('krogmann_uploads')
                    .update({ processed: true })
                    .eq('id', file.id);
                
                addLog('krogmann', `Completed ${file.filename}: ${entries.length} entries`, 'success');
                
            } catch (error) {
                addLog('krogmann', `Error processing ${file.filename}: ${error.message}`, 'error');
                results.errors++;
            }
        }
        
        // Calculate processing time
        const processingTime = Math.round((Date.now() - state.startTime) / 1000);
        results.processingTime = `${Math.floor(processingTime / 60)}m ${processingTime % 60}s`;
        
        state.results = results;
        state.status = 'Completed';
        state.progress = 1;
        
        addLog('krogmann', `Processing completed: ${results.conceptsEnriched} concepts enriched`, 'success');
        
    } catch (error) {
        addLog('krogmann', `Critical error: ${error.message}`, 'error');
        state.status = 'Error';
        throw error;
    } finally {
        state.isProcessing = false;
    }
}

async function processKrogmannEntry(entry, results) {
    // Find concept by German meaning
    const { data: concept } = await supabase
        .from('concepts')
        .select('*')
        .eq('primary_german_label', entry.germanMeaning)
        .single();
        
    if (!concept) {
        // Create new concept if not found
        const { data: newConcept } = await supabase
            .from('concepts')
            .insert({
                primary_german_label: entry.germanMeaning,
                part_of_speech: entry.wordType
            })
            .select()
            .single();
            
        if (newConcept) {
            results.conceptsCreated++;
            
            // Process the entry with the new concept
            await enrichConceptWithKrogmann(newConcept, entry, results);
        }
    } else {
        // Enrich existing concept
        await enrichConceptWithKrogmann(concept, entry, results);
        results.conceptsEnriched++;
    }
}

async function enrichConceptWithKrogmann(concept, entry, results) {
    // Create or update Halunder term
    const { data: halunderTerm } = await supabase
        .from('terms')
        .upsert({
            term_text: entry.halunderWord,
            language: 'hal'
        }, {
            onConflict: 'term_text,language'
        })
        .select()
        .single();
        
    if (halunderTerm) {
        // Link to concept with Krogmann data
        await supabase
            .from('concept_to_term')
            .upsert({
                concept_id: concept.id,
                term_id: halunderTerm.id,
                pronunciation: entry.pronunciation,
                gender: entry.gender,
                plural_form: entry.plural,
                homonym_number: entry.homonymNumber,
                source_name: 'krogmann'
            });
    }
    
    // Add examples
    if (entry.examples) {
        for (const example of entry.examples) {
            await supabase
                .from('examples')
                .insert({
                    concept_id: concept.id,
                    halunder_sentence: example.halunder,
                    german_sentence: example.german,
                    note: example.note,
                    source_name: 'krogmann'
                });
            results.examplesCreated++;
        }
    }
}

async function processCSVData() {
    const state = processingStates.csv;
    
    try {
        addLog('csv', 'Starting CSV data processing', 'info');
        
        // Read CSV file
        state.status = 'Reading CSV file...';
        const csvPath = path.join(__dirname, 'public', 'miin_iaars_duusend_wurder.csv');
        const csvContent = await fs.readFile(csvPath, 'utf8');
        
        // Parse CSV
        const parsed = Papa.parse(csvContent, {
            header: true,
            skipEmptyLines: true
        });
        
        addLog('csv', `Found ${parsed.data.length} entries in CSV`, 'info');
        state.progress = 0.2;
        
        const results = {
            totalProcessed: 0,
            conceptsCreated: 0,
            termsCreated: 0,
            errors: 0
        };
        
        // Process each CSV entry
        for (let i = 0; i < parsed.data.length; i++) {
            const entry = parsed.data[i];
            state.status = `Processing CSV entries`;
            state.details = `Entry ${i + 1} of ${parsed.data.length}`;
            state.progress = 0.2 + (0.7 * (i / parsed.data.length));
            
            try {
                await processCSVEntry(entry, results);
                results.totalProcessed++;
            } catch (error) {
                addLog('csv', `Error processing entry: ${error.message}`, 'warning');
                results.errors++;
            }
        }
        
        // Calculate processing time
        const processingTime = Math.round((Date.now() - state.startTime) / 1000);
        results.processingTime = `${Math.floor(processingTime / 60)}m ${processingTime % 60}s`;
        
        state.results = results;
        state.status = 'Completed';
        state.progress = 1;
        
        addLog('csv', `Processing completed: ${results.conceptsCreated} concepts created`, 'success');
        
    } catch (error) {
        addLog('csv', `Critical error: ${error.message}`, 'error');
        state.status = 'Error';
        throw error;
    } finally {
        state.isProcessing = false;
    }
}

async function processCSVEntry(entry, results) {
    // Extract German and Halunder terms from CSV
    // Adjust these field names based on your actual CSV structure
    const germanTerm = entry.German || entry.german || entry.Deutsch;
    const halunderTerm = entry.Halunder || entry.halunder || entry.Helgoländisch;
    
    if (!germanTerm || !halunderTerm) {
        return; // Skip invalid entries
    }
    
    // Check if concept exists
    const { data: existingConcept } = await supabase
        .from('concepts')
        .select('*')
        .eq('primary_german_label', germanTerm)
        .single();
        
    let concept = existingConcept;
    
    if (!concept) {
        // Create new concept
        const { data: newConcept } = await supabase
            .from('concepts')
            .insert({
                primary_german_label: germanTerm,
                part_of_speech: 'noun' // Default, since CSV doesn't specify
            })
            .select()
            .single();
            
        concept = newConcept;
        if (concept) {
            results.conceptsCreated++;
        }
    }
    
    if (concept) {
        // Create terms
        const { data: germanTermData } = await supabase
            .from('terms')
            .upsert({
                term_text: germanTerm,
                language: 'de'
            }, {
                onConflict: 'term_text,language'
            })
            .select()
            .single();
            
        const { data: halunderTermData } = await supabase
            .from('terms')
            .upsert({
                term_text: halunderTerm,
                language: 'hal'
            }, {
                onConflict: 'term_text,language'
            })
            .select()
            .single();
            
        if (germanTermData) results.termsCreated++;
        if (halunderTermData) results.termsCreated++;
        
        // Link Halunder term to concept
        if (halunderTermData) {
            await supabase
                .from('concept_to_term')
                .upsert({
                    concept_id: concept.id,
                    term_id: halunderTermData.id,
                    source_name: 'miin_iaars_duusend'
                });
        }
    }
}

// Search dictionary entries
router.get('/search', async (req, res) => {
    try {
        const { term, letter, lang = 'both', page = 1 } = req.query;
        const limit = 20;
        const offset = (page - 1) * limit;
        
        let query = supabase
            .from('concepts')
            .select(`
                id,
                primary_german_label,
                part_of_speech,
                notes,
                concept_to_term!inner (
                    pronunciation,
                    gender,
                    plural_form,
                    etymology,
                    homonym_number,
                    term:terms!inner (
                        term_text,
                        language
                    )
                ),
                examples (
                    halunder_sentence,
                    german_sentence,
                    note
                ),
                source_relations:relations!source_concept_id (
                    relation_type,
                    target_concept:concepts!target_concept_id (
                        primary_german_label
                    )
                )
            `)
            .order('primary_german_label');
        
        // Apply filters
        if (term) {
            if (lang === 'de') {
                query = query.ilike('primary_german_label', `%${term}%`);
            } else if (lang === 'hal') {
                query = query.ilike('concept_to_term.term.term_text', `%${term}%`);
            } else {
                // Search both languages
                query = query.or(`primary_german_label.ilike.%${term}%,concept_to_term.term.term_text.ilike.%${term}%`);
            }
        } else if (letter) {
            query = query.ilike('primary_german_label', `${letter}%`);
        }
        
        // Get total count
        const { count } = await query;
        
        // Get paginated results
        const { data, error } = await query
            .range(offset, offset + limit - 1);
            
        if (error) throw error;
        
        // Transform data for frontend
const entries = data.map(concept => ({
    id: concept.id,
    headword: concept.primary_german_label,
    partOfSpeech: concept.part_of_speech,
    notes: concept.notes,  // Add this line
    homonymNumber: concept.concept_to_term[0]?.homonym_number,
    translations: concept.concept_to_term
        .filter(ct => ct.term.language === 'hal')
        .map(ct => ({
            term: ct.term.term_text,
            pronunciation: ct.pronunciation,
            gender: ct.gender,
            plural: ct.plural_form,
            etymology: ct.etymology,
            note: ct.note  // Add this line to include translation notes
        })),
    examples: concept.examples.map(ex => ({
        halunder: ex.halunder_sentence,
        german: ex.german_sentence,
        note: ex.note
    })),
    relations: concept.source_relations.map(rel => ({
        type: rel.relation_type.replace('_', ' '),
        targetTerm: rel.target_concept.primary_german_label,
        note: rel.note  // Add this line
    }))
}));
        
        res.json({
            entries,
            totalEntries: count || 0,
            totalPages: Math.ceil((count || 0) / limit),
            currentPage: parseInt(page)
        });
        
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
