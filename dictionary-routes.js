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
    ahrhammar: { isProcessing: false, progress: 0, status: 'idle', details: '', logs: [], results: null },
    krogmann: { isProcessing: false, progress: 0, status: 'idle', details: '', logs: [], results: null },
    csv: { isProcessing: false, progress: 0, status: 'idle', details: '', logs: [], results: null },
    admin: { isProcessing: false, progress: 0, status: 'idle', details: '', logs: [], results: null }
};

// Helper function to add logs
function addLog(processType, message, type = 'info') {
    if (!processingStates[processType]) {
        console.error(`[LOGGING ERROR] Invalid process type: ${processType}. Message: ${message}`);
        return;
    }
    const log = { id: Date.now() + Math.random(), message, type, timestamp: new Date().toISOString() };
    processingStates[processType].logs.push(log);
    if (processingStates[processType].logs.length > 1000) {
        processingStates[processType].logs = processingStates[processType].logs.slice(-1000);
    }
    console.log(`[${processType.toUpperCase()}] [${type.toUpperCase()}] ${message}`);
}

// --- NEW HELPER: Simple German noun singularization (Improved) ---
function attemptSingularization(term) {
    if (term.endsWith('en') && term.length > 3) return term.slice(0, -1); // Marken -> Marke
    if (term.endsWith('er') && term.length > 3) return term.slice(0, -2); // Männer -> Mann (imperfect)
    if (term.endsWith('e') && term.length > 2) return term.slice(0, -1);  // Risse -> Riss
    if (term.endsWith('n') && term.length > 2) return term.slice(0, -1);  // Frauen -> Frau
    if (term.endsWith('s') && term.length > 2) return term.slice(0, -1);  // Autos -> Auto
    return null;
}

// --- FINAL ENHANCED HELPER: Finds concept IDs with multi-stage fallback logic ---
async function findTargetConceptId(dirtyTerm) {
    if (!dirtyTerm) return null;

    const cleanGermanTerm = (term) => {
        return term
            .replace(/\d+$/, '')             // nieder2 -> nieder
            .replace(/-$/, '')               // dran- -> dran
            .replace(/!$/, '')               // klack! -> klack
            .replace(/\s*\(.*\)\s*$/, '')    // (festlich) angezogen -> festlich angezogen
            .replace(/\s*,\s*sich\s*$/, '')   // trennen, sich -> trennen
            .replace(/\*$/, '')              // fliten* -> fliten
            .trim();
    };

    const attemptMatch = async (term) => {
        if (!term) return null;
        const { data } = await supabase.from('concepts').select('id').eq('primary_german_label', term).single();
        return data ? data.id : null;
    };

    // Attempt 1: Exact match
    let conceptId = await attemptMatch(dirtyTerm);
    if (conceptId) return conceptId;

    // Attempt 2: Cleaned match
    const cleanedTerm = cleanGermanTerm(dirtyTerm);
    conceptId = await attemptMatch(cleanedTerm);
    if (conceptId) return conceptId;
    
    // Attempt 3: Handle slash-separated alternatives (e.g., Fels/en)
    if (cleanedTerm.includes('/')) {
        const parts = cleanedTerm.split('/');
        const firstPart = parts[0].trim();
        const secondPart = (parts[0].endsWith('-') ? parts[0].slice(0,-1) : '') + parts[1].trim();
        
        conceptId = await attemptMatch(firstPart) || await attemptMatch(secondPart);
        if (conceptId) return conceptId;
    }

    // Attempt 4: Singularization attempt
    const singularAttempt = attemptSingularization(cleanedTerm);
    if (singularAttempt) {
        conceptId = await attemptMatch(singularAttempt);
        if (conceptId) return conceptId;
    }
    
    // Attempt 5: First word of a phrase
    const firstWord = cleanedTerm.split(/[\s,]+/)[0];
    if (firstWord && firstWord.length > 2 && firstWord !== cleanedTerm) {
        conceptId = await attemptMatch(firstWord);
        if (conceptId) return conceptId;
    }

    // Attempt 6: Halunder term match
    const { data: halunderMatch } = await supabase.from('terms').select('concept_to_term!inner(concept_id)').eq('term_text', dirtyTerm).eq('language', 'hal').maybeSingle();
    if (halunderMatch && halunderMatch.concept_to_term) return halunderMatch.concept_to_term.concept_id;
    
    return null; // All attempts failed
}

// --- API ROUTES ---

router.get('/stats', async (req, res) => {
    try {
        const { count: ahrhammarCount } = await supabase.from('pdf_analyses').select('*', { count: 'exact', head: true });
        const { count: krogmannCount } = await supabase.from('krogmann_uploads').select('*', { count: 'exact', head: true });
        const { count: conceptsCount } = await supabase.from('concepts').select('*', { count: 'exact', head: true });
        const { count: termsCount } = await supabase.from('terms').select('*', { count: 'exact', head: true });
        let csvCount = 0;
        try {
            const csvPath = path.join(__dirname, 'public', 'miin_iaars_duusend_wurder.csv');
            const csvContent = await fs.readFile(csvPath, 'utf8');
            csvCount = Papa.parse(csvContent, { header: true, skipEmptyLines: true }).data.length;
        } catch (error) { console.log('CSV file not found or error reading'); }
        res.json({ ahrhammarCount: ahrhammarCount || 0, krogmannCount: krogmannCount || 0, csvCount, conceptsCount: conceptsCount || 0, termsCount: termsCount || 0 });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/upload-krogmann', async (req, res) => {
    try {
        const { filename, data } = req.body;
        const { error } = await supabase.from('krogmann_uploads').insert([{ filename, data, processed: false }]);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

function startProcessing(processType, processFunction) {
    return async (req, res) => {
        try {
            if (processingStates[processType].isProcessing) return res.status(400).json({ error: `${processType} processing already in progress` });
            processingStates[processType] = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], results: null, startTime: Date.now() };
            processFunction().catch(error => {
                console.error(`${processType} processing error:`, error);
                addLog(processType, `Critical error: ${error.message}`, 'error');
                processingStates[processType].status = 'Error';
                processingStates[processType].isProcessing = false;
            });
            res.json({ success: true, message: `${processType} processing started` });
        } catch (error) {
            console.error(`Start ${processType} processing error:`, error);
            res.status(500).json({ error: error.message });
        }
    };
}

router.post('/process-ahrhammar', startProcessing('ahrhammar', processAhrhammarData));
router.post('/process-krogmann', startProcessing('krogmann', processKrogmannData));
router.post('/process-csv', startProcessing('csv', processCSVData));

router.get('/progress/:type', (req, res) => {
    const processType = req.params.type;
    const state = processingStates[processType];
    if (!state) return res.status(404).json({ error: 'Invalid process type' });
    const percentage = Math.round(state.progress * 100);
    const completed = !state.isProcessing && state.results !== null;
    res.json({ percentage, status: state.status, details: state.details, logs: state.logs.slice(-50), completed, results: state.results });
});


// --- AHRHAMMAR PROCESSING LOGIC ---

async function processAhrhammarData() {
    const state = processingStates.ahrhammar;
    try {
        addLog('ahrhammar', 'Starting Ahrhammar data processing', 'info');
        state.status = 'Fetching PDF analyses...';
        const { data: pdfAnalyses, error } = await supabase.from('pdf_analyses').select('*').order('id');
        if (error) throw error;
        addLog('ahrhammar', `Found ${pdfAnalyses.length} PDF analyses to process`, 'info');
        state.progress = 0.05;
        const globalResults = { totalProcessed: 0, conceptsCreated: 0, termsCreated: 0, examplesCreated: 0, relationsCreated: 0, errors: 0 };

        // Pass 1: Concepts & Terms
        addLog('ahrhammar', 'First pass: Creating concepts and terms', 'info');
        for (let i = 0; i < pdfAnalyses.length; i++) {
            const analysis = pdfAnalyses[i];
            state.status = `Pass 1/2: ${analysis.filename}`;
            state.details = `File ${i + 1} of ${pdfAnalyses.length}`;
            state.progress = 0.05 + (0.45 * ((i + 1) / pdfAnalyses.length));
            
            const perFileResults = { entries: 0, terms: 0, examples: 0 };
            try {
                let jsonData = analysis.result.replace(/^```json\s*|```$/g, '');
                const entries = JSON.parse(jsonData);
                perFileResults.entries = entries.length;
                for (const entry of entries) {
                    await processAhrhammarEntryFirstPass(entry, globalResults, perFileResults);
                }
                addLog('ahrhammar', `File ${analysis.filename} (Pass 1): Processed ${perFileResults.entries} entries. Added ${perFileResults.terms} terms, ${perFileResults.examples} examples.`, 'info');
            } catch (e) {
                addLog('ahrhammar', `Error processing ${analysis.filename} in Pass 1: ${e.message}`, 'error');
                globalResults.errors++;
            }
        }

        // Pass 2: Relations
        addLog('ahrhammar', 'Second pass: Creating relations', 'info');
        for (let i = 0; i < pdfAnalyses.length; i++) {
            const analysis = pdfAnalyses[i];
            state.status = `Pass 2/2: ${analysis.filename}`;
            state.details = `File ${i + 1} of ${pdfAnalyses.length}`;
            state.progress = 0.5 + (0.45 * ((i + 1) / pdfAnalyses.length));

            const perFileResults = { relations: 0, skipped: 0 };
            try {
                let jsonData = analysis.result.replace(/^```json\s*|```$/g, '');
                const entries = JSON.parse(jsonData);
                for (const entry of entries) {
                    await processAhrhammarRelations(entry, globalResults, perFileResults);
                }
                addLog('ahrhammar', `File ${analysis.filename} (Pass 2): Created ${perFileResults.relations} relations, skipped ${perFileResults.skipped}.`, 'info');
            } catch (e) {
                addLog('ahrhammar', `Error processing ${analysis.filename} in Pass 2: ${e.message}`, 'error');
                globalResults.errors++;
            }
        }

        const processingTime = Math.round((Date.now() - state.startTime) / 1000);
        globalResults.processingTime = `${Math.floor(processingTime / 60)}m ${processingTime % 60}s`;
        state.results = globalResults;
        state.status = 'Completed';
        state.progress = 1;
        addLog('ahrhammar', `Processing completed`, 'success');
    } catch (error) {
        addLog('ahrhammar', `Critical error: ${error.message}`, 'error');
        state.status = 'Error';
        throw error;
    } finally {
        state.isProcessing = false;
    }
}

async function processAhrhammarEntryFirstPass(entry, globalResults, perFileResults) {
    globalResults.totalProcessed++;
    const { data: concept } = await supabase.from('concepts').upsert({ primary_german_label: entry.headword, part_of_speech: entry.partOfSpeech, notes: entry.usageNotes ? entry.usageNotes.join('; ') : null }, { onConflict: 'primary_german_label' }).select('id').single();
    if (!concept) throw new Error(`Could not upsert concept for ${entry.headword}`);
    globalResults.conceptsCreated++;
    
    await supabase.from('terms').upsert({ term_text: entry.headword, language: 'de' }, { onConflict: 'term_text,language' });
    globalResults.termsCreated++;
    perFileResults.terms++;

    if (entry.translations) for (const translation of entry.translations) {
        const { data: halunderTerm } = await supabase.from('terms').upsert({ term_text: translation.term, language: 'hal' }, { onConflict: 'term_text,language' }).select('id').single();
        if (halunderTerm) {
            globalResults.termsCreated++;
            perFileResults.terms++;
            await supabase.from('concept_to_term').upsert({ concept_id: concept.id, term_id: halunderTerm.id, pronunciation: translation.pronunciation, gender: translation.gender, plural_form: translation.plural, etymology: translation.etymology, note: translation.note, homonym_number: entry.homonymNumber, source_name: 'ahrhammar' }, { onConflict: 'concept_id,term_id,source_name' });
        }
    }
    if (entry.examples) for (const example of entry.examples) {
        await supabase.from('examples').insert({ concept_id: concept.id, halunder_sentence: example.halunder, german_sentence: example.german, note: example.note, source_name: 'ahrhammar' });
        globalResults.examplesCreated++;
        perFileResults.examples++;
    }
}

async function processAhrhammarRelations(entry, results, perFileResults) {
    if (!entry.relations || entry.relations.length === 0) return;
    const { data: sourceConcept } = await supabase.from('concepts').select('id').eq('primary_german_label', entry.headword).single();
    if (!sourceConcept) return;
    for (const relation of entry.relations) {
        const targetConceptId = await findTargetConceptId(relation.targetTerm);
        if (targetConceptId) {
            const { error } = await supabase.from('relations').insert({ source_concept_id: sourceConcept.id, target_concept_id: targetConceptId, relation_type: relation.type, note: relation.note });
            if (!error) {
                results.relationsCreated++;
                perFileResults.relations++;
            }
        } else {
            perFileResults.skipped++;
            addLog('ahrhammar', `Target concept not found for relation: ${entry.headword} -> ${relation.targetTerm}`, 'warning');
        }
    }
}


// --- KROGMANN PROCESSING LOGIC (REVISED) ---

async function processKrogmannData() {
    const state = processingStates.krogmann;
    try {
        addLog('krogmann', 'Starting Krogmann data processing', 'info');
        state.status = 'Fetching Krogmann data...';
        const { data: krogmannData, error } = await supabase.from('krogmann_uploads').select('*').eq('processed', false).order('filename');
        if (error) throw error;
        addLog('krogmann', `Found ${krogmannData.length} Krogmann files to process`, 'info');
        state.progress = 0.1;
        const globalResults = { totalProcessed: 0, conceptsCreated: 0, conceptsEnriched: 0, termsCreated: 0, examplesCreated: 0, relationsCreated: 0, errors: 0 };

        for (let i = 0; i < krogmannData.length; i++) {
            const file = krogmannData[i];
            state.status = `Processing ${file.filename}`;
            state.details = `File ${i + 1} of ${krogmannData.length}`;
            state.progress = 0.1 + (0.8 * ((i + 1) / krogmannData.length));
            const perFileResults = { entries: 0, enriched: 0, created: 0, examples: 0, relations: 0, errors: 0 };
            try {
                const entries = file.data;
                perFileResults.entries = entries.length;
                for (const entry of entries) {
                    await processKrogmannEntry(entry, globalResults, perFileResults);
                }
                await supabase.from('krogmann_uploads').update({ processed: true }).eq('id', file.id);
                addLog('krogmann', `File ${file.filename}: Processed ${perFileResults.entries} entries. Enriched ${perFileResults.enriched}, created ${perFileResults.created}, added ${perFileResults.examples} examples & ${perFileResults.relations} relations.`, 'info');
            } catch (e) {
                addLog('krogmann', `Error processing file ${file.filename}: ${e.message}`, 'error');
                globalResults.errors++;
            }
        }

        const processingTime = Math.round((Date.now() - state.startTime) / 1000);
        globalResults.processingTime = `${Math.floor(processingTime / 60)}m ${processingTime % 60}s`;
        state.results = globalResults;
        state.status = 'Completed';
        state.progress = 1;
        addLog('krogmann', `Processing completed`, 'success');
    } catch (error) {
        addLog('krogmann', `Critical error: ${error.message}`, 'error');
        state.status = 'Error';
        throw error;
    } finally {
        state.isProcessing = false;
    }
}

async function processKrogmannEntry(entry, globalResults, perFileResults) {
    globalResults.totalProcessed++;
    let { data: concept } = await supabase.from('concepts').select('*').eq('primary_german_label', entry.germanMeaning).single();
    
    if (concept) {
        // Concept exists, enrich it
        perFileResults.enriched++;
        await enrichConceptWithKrogmann(concept, entry, globalResults, perFileResults, 'krogmann');
    } else {
        // Concept does not exist, create it from Krogmann data
        perFileResults.created++;
        let initialNotes = [];
        if (entry.additionalInfo) initialNotes.push(`[Krogmann Info] ${entry.additionalInfo}`);
        if (entry.idioms) initialNotes.push(`[Krogmann Idiom] ${entry.idioms}`);
        if (entry.references) initialNotes.push(`[Krogmann Reference] ${entry.references}`);

        const { data: newConcept, error } = await supabase.from('concepts').insert({ 
            primary_german_label: entry.germanMeaning, 
            part_of_speech: entry.wordType,
            notes: initialNotes.join('\n\n---\n\n')
        }).select().single();

        if (error) throw error;
        globalResults.conceptsCreated++;
        await enrichConceptWithKrogmann(newConcept, entry, globalResults, perFileResults, 'krogmann');
    }
}

async function enrichConceptWithKrogmann(concept, entry, globalResults, perFileResults, sourceName) {
    if (concept.notes && !concept.notes.includes('[Krogmann Info]')) {
        let newNoteParts = [];
        if (entry.additionalInfo) newNoteParts.push(`[Krogmann Info] ${entry.additionalInfo}`);
        if (entry.idioms) newNoteParts.push(`[Krogmann Idiom] ${entry.idioms}`);
        if (entry.references) newNoteParts.push(`[Krogmann Reference] ${entry.references}`);
        
        if (newNoteParts.length > 0) {
            const enrichmentText = newNoteParts.join('\n\n---\n\n');
            const combinedNotes = `${concept.notes}\n\n---\n\n${enrichmentText}`;
            const { error } = await supabase.from('concepts').update({ notes: combinedNotes }).eq('id', concept.id);
            if (error) addLog('krogmann', `Failed to enrich notes for ${concept.primary_german_label}: ${error.message}`, 'error');
            else globalResults.conceptsEnriched++;
        }
    }

    const { data: halunderTerm } = await supabase.from('terms').upsert({ term_text: entry.halunderWord, language: 'hal' }, { onConflict: 'term_text,language' }).select('id').single();
    if (halunderTerm) {
        globalResults.termsCreated++;
        await supabase.from('concept_to_term').upsert({
            concept_id: concept.id,
            term_id: halunderTerm.id,
            pronunciation: entry.pronunciation,
            gender: entry.gender,
            plural_form: entry.plural,
            homonym_number: entry.homonymNumber,
            source_name: sourceName
        }, { onConflict: 'concept_id,term_id,source_name' });
    }

    if (entry.examples) for (const example of entry.examples) {
        await supabase.from('examples').insert({ concept_id: concept.id, halunder_sentence: example.halunder, german_sentence: example.german, note: example.note, source_name: sourceName });
        globalResults.examplesCreated++;
        perFileResults.examples++;
    }
    
    if(entry.relatedWords) for (const related of entry.relatedWords) {
        const targetConceptId = await findTargetConceptId(related);
        if(targetConceptId) {
            const { error } = await supabase.from('relations').insert({ source_concept_id: concept.id, target_concept_id: targetConceptId, relation_type: 'see_also', note: `From ${sourceName}` });
            if (!error) {
                globalResults.relationsCreated++;
                perFileResults.relations++;
            }
        } else {
            addLog('krogmann', `Target concept not found for Krogmann relation: ${concept.primary_german_label} -> ${related}`, 'warning');
        }
    }
}


// --- CSV & OTHER ROUTES ---
async function processCSVData() {
    const state = processingStates.csv;
    try {
        addLog('csv', 'Starting CSV data processing', 'info');
        state.status = 'Reading CSV file...';
        const csvPath = path.join(__dirname, 'public', 'miin_iaars_duusend_wurder.csv');
        const csvContent = await fs.readFile(csvPath, 'utf8');
        const parsed = Papa.parse(csvContent, { header: true, skipEmptyLines: true });
        addLog('csv', `Found ${parsed.data.length} entries in CSV`, 'info');
        state.progress = 0.2;
        const results = { totalProcessed: 0, conceptsCreated: 0, termsCreated: 0, errors: 0 };
        for (let i = 0; i < parsed.data.length; i++) {
            const entry = parsed.data[i];
            state.status = `Processing CSV entries`;
            state.details = `Entry ${i + 1} of ${parsed.data.length}`;
            state.progress = 0.2 + (0.7 * ((i + 1) / parsed.data.length));
            try {
                await processCSVEntry(entry, results);
            } catch (error) {
                addLog('csv', `Error processing entry: ${error.message}`, 'warning');
                results.errors++;
            }
        }
        const processingTime = Math.round((Date.now() - state.startTime) / 1000);
        results.processingTime = `${Math.floor(processingTime / 60)}m ${processingTime % 60}s`;
        state.results = results;
        state.status = 'Completed';
        state.progress = 1;
        addLog('csv', `Processing completed`, 'success');
    } catch (error) {
        addLog('csv', `Critical error: ${error.message}`, 'error');
        state.status = 'Error';
        throw error;
    } finally {
        state.isProcessing = false;
    }
}

async function processCSVEntry(entry, results) {
    results.totalProcessed++;
    const germanTerm = entry.German || entry.german || entry.Deutsch;
    const halunderTerm = entry.Halunder || entry.halunder || entry.Helgoländisch;
    if (!germanTerm || !halunderTerm) return;
    const { data: concept } = await supabase.from('concepts').upsert({ primary_german_label: germanTerm, part_of_speech: 'noun' }, { onConflict: 'primary_german_label' }).select('id').single();
    if (concept) {
        results.conceptsCreated++;
        await supabase.from('terms').upsert({ term_text: germanTerm, language: 'de' }, { onConflict: 'term_text,language' });
        const { data: halunderTermData } = await supabase.from('terms').upsert({ term_text: halunderTerm, language: 'hal' }, { onConflict: 'term_text,language' }).select('id').single();
        results.termsCreated += 2;
        if (halunderTermData) {
            await supabase.from('concept_to_term').upsert({ concept_id: concept.id, term_id: halunderTermData.id, source_name: 'miin_iaars_duusend' }, { onConflict: 'concept_id,term_id' });
        }
    }
}

router.get('/search', async (req, res) => {
    try {
        const { term, letter, lang = 'both', page = 1 } = req.query;
        const limit = 20;
        const offset = (page - 1) * limit;
        
        let query = supabase
            .from('concepts')
            .select(`
                id, primary_german_label, part_of_speech, notes,
                concept_to_term!inner (pronunciation, gender, plural_form, etymology, homonym_number, note, source_name, term:terms!inner(term_text, language)),
                examples (halunder_sentence, german_sentence, note),
                source_relations:relations!source_concept_id (relation_type, note, target_concept:concepts!target_concept_id (id, primary_german_label))
            `, { count: 'exact' })
            .order('primary_german_label');
        
        if (term) {
            if (lang === 'de') query = query.ilike('primary_german_label', `%${term}%`);
            else if (lang === 'hal') query = query.ilike('concept_to_term.term.term_text', `%${term}%`);
            else query = query.or(`primary_german_label.ilike.%${term}%,concept_to_term.term.term_text.ilike.%${term}%`);
        } else if (letter) {
            query = query.ilike('primary_german_label', `${letter}%`);
        }
        
        const { data, error, count } = await query.range(offset, offset + limit - 1);
        if (error) throw error;
        
        const entries = data.map(concept => {
            const translationMap = new Map();
            concept.concept_to_term.filter(ct => ct.term.language === 'hal').forEach(ct => {
                const key = ct.term.term_text;
                if (!translationMap.has(key)) {
                    translationMap.set(key, { term: ct.term.term_text, pronunciation: ct.pronunciation, gender: ct.gender, plural: ct.plural_form, etymology: ct.etymology, note: ct.note, sources: [] });
                }
                translationMap.get(key).sources.push(ct.source_name);
            });
            return {
                id: concept.id,
                headword: concept.primary_german_label,
                partOfSpeech: concept.part_of_speech,
                usageNotes: concept.notes,
                homonymNumber: concept.concept_to_term[0]?.homonym_number,
                translations: Array.from(translationMap.values()),
                examples: concept.examples.map(ex => ({ halunder: ex.halunder_sentence, german: ex.german_sentence, note: ex.note })),
                relations: concept.source_relations.map(rel => ({ type: rel.relation_type.replace('_', ' '), targetTerm: rel.target_concept.primary_german_label, targetId: rel.target_concept.id, note: rel.note }))
            };
        });
        
        res.json({ entries, totalEntries: count || 0, totalPages: Math.ceil((count || 0) / limit), currentPage: parseInt(page) });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/clear-all', async (req, res) => {
    try {
        addLog('admin', 'Starting to clear all dictionary data...', 'warning');
        await supabase.from('relations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('examples').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('concept_to_term').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('terms').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('concepts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        addLog('admin', 'All dictionary data cleared successfully.', 'success');
        res.json({ success: true, message: 'All dictionary data cleared' });
    } catch (error) {
        console.error('Clear data error:', error);
        addLog('admin', `Error clearing data: ${error.message}`, 'error');
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
