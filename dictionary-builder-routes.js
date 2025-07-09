const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const Papa = require('papaparse');
const path = require('path');
const fs = require('fs').promises;

// Use the SOURCE database for ALL operations now
const supabase = createClient(
    process.env.SOURCE_SUPABASE_URL,
    process.env.SOURCE_SUPABASE_ANON_KEY
);

// State management for each process
let processingStates = {
    ahrhammar: { isProcessing: false, progress: 0, status: 'idle', details: '', logs: [], results: null },
    krogmann: { isProcessing: false, progress: 0, status: 'idle', details: '', logs: [], results: null },
    csv: { isProcessing: false, progress: 0, status: 'idle', details: '', logs: [], results: null },
    admin: { isProcessing: false, progress: 0, status: 'idle', details: '', logs: [], results: null }
};

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

async function findTargetConceptId(dirtyTerm) {
    if (!dirtyTerm) return null;
    const cleanGermanTerm = (term) => term.replace(/\d+$/, '').replace(/[¹²³]$/, '').replace(/-$/, '').replace(/!$/, '').replace(/\s*\(.*\)\s*$/, '').replace(/\s*,\s*sich\s*$/, '').replace(/\*$/, '').trim();
    const attemptSingularization = (term) => {
        if (term.endsWith('en') && term.length > 3) return term.slice(0, -1);
        if (term.endsWith('er') && term.length > 3) return term.slice(0, -2);
        if (term.endsWith('e') && term.length > 2) return term.slice(0, -1);
        if (term.endsWith('n') && term.length > 2) return term.slice(0, -1);
        if (term.endsWith('s') && term.length > 2) return term.slice(0, -1);
        return null;
    }
    const attemptMatch = async (term) => {
        if (!term) return null;
        const { data } = await supabase.from('new_concepts').select('id').eq('primary_german_label', term).limit(1).single();
        return data ? data.id : null;
    };
    const strategies = [
        () => attemptMatch(dirtyTerm),
        () => attemptMatch(cleanGermanTerm(dirtyTerm)),
        () => {
            const cleaned = cleanGermanTerm(dirtyTerm);
            if (cleaned.includes('/')) {
                const parts = cleaned.split('/');
                const firstPart = parts[0].trim();
                const secondPart = (parts[0].endsWith('-') ? parts[0].slice(0, -1) : '') + parts[1].trim();
                return attemptMatch(firstPart).then(id => id || attemptMatch(secondPart));
            }
            return Promise.resolve(null);
        },
        () => attemptMatch(attemptSingularization(cleanGermanTerm(dirtyTerm))),
        () => {
            const cleaned = cleanGermanTerm(dirtyTerm);
            const firstWord = cleaned.split(/[\s,]+/)[0];
            return (firstWord && firstWord.length > 2 && firstWord !== cleaned) ? attemptMatch(firstWord) : Promise.resolve(null);
        },
        async () => {
            const { data: halunderMatch } = await supabase.from('new_terms').select('new_concept_to_term!inner(concept_id)').eq('term_text', dirtyTerm).eq('language', 'hal').limit(1).single();
            if (halunderMatch && halunderMatch.new_concept_to_term) {
                return Array.isArray(halunderMatch.new_concept_to_term) ? halunderMatch.new_concept_to_term[0]?.concept_id : halunderMatch.new_concept_to_term.concept_id;
            }
            return null;
        }
    ];
    for (const strategy of strategies) {
        const conceptId = await strategy();
        if (conceptId) return conceptId;
    }
    return null;
}

router.get('/stats', async (req, res) => {
    try {
        const { count: ahrhammarCount } = await supabase.from('ahrhammar_uploads').select('*', { count: 'exact', head: true });
        const { count: krogmannCount } = await supabase.from('krogmann_uploads').select('*', { count: 'exact', head: true });
        const { count: conceptsCount } = await supabase.from('new_concepts').select('*', { count: 'exact', head: true });
        const { count: termsCount } = await supabase.from('new_terms').select('*', { count: 'exact', head: true });
        let csvCount = 0;
        try {
            // --- FIX IS HERE: Corrected the file path ---
            const csvPath = path.join(__dirname, '..', 'public', 'miin_iaars_duusend_wurder.csv');
            const csvContent = await fs.readFile(csvPath, 'utf8');
            csvCount = Papa.parse(csvContent, { header: true, skipEmptyLines: true }).data.length;
        } catch (error) { 
            console.log('CSV file not found or error reading:', error.message); 
        }
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

async function processAhrhammarData() {
    const state = processingStates.ahrhammar;
    try {
        addLog('ahrhammar', 'Starting Ahrhammar data processing', 'info');
        state.status = 'Fetching Ahrhammar uploads...';
        const { data: pdfAnalyses, error } = await supabase.from('ahrhammar_uploads').select('*').order('id');
        if (error) throw error;
        addLog('ahrhammar', `Found ${pdfAnalyses.length} Ahrhammar uploads to process`, 'info');
        state.progress = 0.05;
        const globalResults = { totalProcessed: 0, conceptsCreated: 0, termsCreated: 0, examplesCreated: 0, relationsCreated: 0, citationsCreated: 0, errors: 0 };

        addLog('ahrhammar', 'First pass: Creating concepts and terms', 'info');
        for (let i = 0; i < pdfAnalyses.length; i++) {
            const analysis = pdfAnalyses[i];
            state.status = `Pass 1/2: ${analysis.filename}`;
            state.details = `File ${i + 1} of ${pdfAnalyses.length}`;
            state.progress = 0.05 + (0.45 * ((i + 1) / pdfAnalyses.length));
            const perFileResults = { entries: 0, terms: 0, examples: 0, citations: 0, links: 0 };
            try {
                let jsonData = typeof analysis.result === 'string' ? analysis.result.replace(/^```json\s*|```$/g, '') : JSON.stringify(analysis.result);
                const entries = JSON.parse(jsonData);
                perFileResults.entries = entries.length;
                for (const entry of entries) {
                    await processAhrhammarEntryFirstPass(entry, globalResults, perFileResults);
                }
                addLog('ahrhammar', `File ${analysis.filename} (Pass 1): Processed ${perFileResults.entries} entries.`, 'info');
            } catch (e) {
                addLog('ahrhammar', `Error processing ${analysis.filename} in Pass 1: ${e.message}`, 'error');
                globalResults.errors++;
            }
        }

        addLog('ahrhammar', 'Second pass: Creating relations', 'info');
        for (let i = 0; i < pdfAnalyses.length; i++) {
            const analysis = pdfAnalyses[i];
            state.status = `Pass 2/2: ${analysis.filename}`;
            state.details = `File ${i + 1} of ${pdfAnalyses.length}`;
            state.progress = 0.5 + (0.45 * ((i + 1) / pdfAnalyses.length));
            const perFileResults = { relations: 0, skipped: 0 };
            try {
                let jsonData = typeof analysis.result === 'string' ? analysis.result.replace(/^```json\s*|```$/g, '') : JSON.stringify(analysis.result);
                const entries = JSON.parse(jsonData);
                for (const entry of entries) {
                    await processAhrhammarRelations(entry, globalResults, perFileResults);
                }
                addLog('ahrhammar', `File ${analysis.filename} (Pass 2): Created ${perFileResults.relations} relations.`, 'info');
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
    if (!entry.senseId) entry.senseId = `${entry.headword}-${Date.now()}-${Math.random()}`;
    const conceptPayload = {
        primary_german_label: entry.headword,
        part_of_speech: entry.partOfSpeech,
        notes: entry.usageNotes ? entry.usageNotes.join('; ') : null,
        german_definition: entry.germanDefinition,
        sense_id: entry.senseId,
        sense_number: entry.senseNumber
    };
    const { data: concept, error } = await supabase.from('new_concepts').upsert(conceptPayload, { onConflict: 'sense_id' }).select('id').single();
    if (error) throw new Error(`Could not upsert concept for ${entry.headword}: ${error.message}`);
    if (!concept) throw new Error(`Upsert returned no data for concept ${entry.headword}`);
    globalResults.conceptsCreated++;
    
    await supabase.from('new_terms').upsert({ term_text: entry.headword, language: 'de' }, { onConflict: 'term_text,language' });
    globalResults.termsCreated++;
    perFileResults.terms++;

    if (entry.translations) for (const translation of entry.translations) {
        const { data: halunderTerm } = await supabase.from('new_terms').upsert({ term_text: translation.term, language: 'hal' }, { onConflict: 'term_text,language' }).select('id').single();
        if (halunderTerm) {
            globalResults.termsCreated++;
            perFileResults.terms++;
            const { error: linkError } = await supabase.from('new_concept_to_term').insert({ concept_id: concept.id, term_id: halunderTerm.id, pronunciation: translation.pronunciation, gender: translation.gender, plural_form: translation.plural, etymology: translation.etymology, note: translation.note, homonym_number: entry.homonymNumber, source_name: 'ahrhammar' });
            if (linkError && linkError.code !== '23505') addLog('ahrhammar', `Error linking term: ${linkError.message}`, 'warning');
            else if (!linkError) perFileResults.links++;
        }
    }
    if (entry.examples) for (const example of entry.examples) {
        await supabase.from('new_examples').insert({ concept_id: concept.id, halunder_sentence: example.halunder, german_sentence: example.german, note: example.note, example_type: example.type, source_name: 'ahrhammar' });
        globalResults.examplesCreated++;
        perFileResults.examples++;
    }
    if (entry.sourceCitations) for (const citation of entry.sourceCitations) {
        await supabase.from('new_source_citations').upsert({ concept_id: concept.id, citation_text: citation }, { onConflict: 'concept_id,citation_text' });
        globalResults.citationsCreated++;
        perFileResults.citations++;
    }
}

async function processAhrhammarRelations(entry, results, perFileResults) {
    if (!entry.relations || entry.relations.length === 0) return;
    const { data: sourceConcept } = await supabase.from('new_concepts').select('id').eq('sense_id', entry.senseId).single();
    if (!sourceConcept) return;
    for (const relation of entry.relations) {
        const targetConceptId = await findTargetConceptId(relation.targetTerm);
        if (targetConceptId) {
            const { error } = await supabase.from('new_relations').insert({ source_concept_id: sourceConcept.id, target_concept_id: targetConceptId, relation_type: relation.type, note: relation.note });
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

async function processKrogmannData() {
    const state = processingStates.krogmann;
    try {
        addLog('krogmann', 'Starting Krogmann data processing', 'info');
        state.status = 'Fetching Krogmann data...';
        const { data: krogmannData, error } = await supabase.from('krogmann_uploads').select('*').eq('processed', false).limit(1000).order('filename');
        if (error) throw error;
        addLog('krogmann', `Found ${krogmannData.length} Krogmann files to process`, 'info');
        state.progress = 0.05;
        const globalResults = { totalProcessed: 0, conceptsCreated: 0, conceptsEnriched: 0, termsCreated: 0, examplesCreated: 0, relationsCreated: 0, errors: 0 };
        const relationsToProcess = [];

        addLog('krogmann', 'First pass: Processing concepts, terms, and examples', 'info');
        for (let i = 0; i < krogmannData.length; i++) {
            const file = krogmannData[i];
            state.status = `Pass 1/2: ${file.filename}`;
            state.details = `File ${i + 1} of ${krogmannData.length}`;
            state.progress = 0.05 + (0.45 * ((i + 1) / krogmannData.length));
            const perFileResults = { entries: 0, enriched: 0, created: 0, examples: 0 };
            try {
                const entries = file.data;
                perFileResults.entries = entries.length;
                for (const entry of entries) {
                    await processKrogmannEntryPass1(entry, globalResults, perFileResults, relationsToProcess);
                }
                await supabase.from('krogmann_uploads').update({ processed: true }).eq('id', file.id);
                addLog('krogmann', `File ${file.filename} (Pass 1): Processed ${perFileResults.entries} entries.`, 'info');
            } catch (e) {
                addLog('krogmann', `Error processing file ${file.filename} in Pass 1: ${e.message}`, 'error');
                globalResults.errors++;
            }
        }

        addLog('krogmann', 'Second pass: Creating Krogmann relations', 'info');
        state.status = 'Pass 2/2: Creating Relations';
        for (let i = 0; i < relationsToProcess.length; i++) {
            const { sourceConceptId, primaryGermanLabel, relatedWord } = relationsToProcess[i];
            state.details = `Relation ${i + 1} of ${relationsToProcess.length}`;
            state.progress = 0.5 + (0.45 * ((i + 1) / relationsToProcess.length));
            const targetConceptId = await findTargetConceptId(relatedWord);
            if (targetConceptId) {
                const { error } = await supabase.from('new_relations').insert({ source_concept_id: sourceConceptId, target_concept_id: targetConceptId, relation_type: 'see_also', note: 'From krogmann' });
                if (!error) globalResults.relationsCreated++;
            } else {
                addLog('krogmann', `Target concept not found for Krogmann relation: ${primaryGermanLabel} -> ${relatedWord}`, 'warning');
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

async function processKrogmannEntryPass1(entry, globalResults, perFileResults, relationsToProcess) {
    try {
        globalResults.totalProcessed++;
        if (!entry.germanMeaning) {
            addLog('krogmann', `Skipping entry '${entry.halunderWord}' because it has no germanMeaning.`, 'warning');
            return;
        }
        const germanMeanings = entry.germanMeaning.split(/[,;]/).map(s => s.trim());
        for (const meaning of germanMeanings) {
            if (!meaning) continue;
            let { data: concept } = await supabase.from('new_concepts').select('*').eq('primary_german_label', meaning).single();
            if (concept) {
                perFileResults.enriched++;
                await enrichConceptWithKrogmann(concept, entry, globalResults, perFileResults, 'krogmann', relationsToProcess);
            } else {
                if (meaning === germanMeanings[0] && meaning.length < 100) {
                    perFileResults.created++;
                    const { data: newConcept, error } = await supabase.from('new_concepts').insert({ 
                        primary_german_label: meaning, 
                        part_of_speech: entry.wordType,
                        krogmann_info: entry.additionalInfo,
                        krogmann_idioms: entry.idioms,
                        notes: entry.references ? `[Reference] ${entry.references}` : null,
                    }).select().single();
                    if (error) {
                        addLog('krogmann', `Error creating new concept for '${meaning}': ${error.message}`, 'error');
                        continue;
                    };
                    globalResults.conceptsCreated++;
                    await enrichConceptWithKrogmann(newConcept, entry, globalResults, perFileResults, 'krogmann', relationsToProcess);
                }
            }
        }
    } catch (e) {
        addLog('krogmann', `CRITICAL ERROR processing entry '${entry.halunderWord}'. Skipping. Error: ${e.message}`, 'error');
        globalResults.errors++;
    }
}

async function enrichConceptWithKrogmann(concept, entry, globalResults, perFileResults, sourceName, relationsToProcess) {
    if (!concept.krogmann_info && !concept.krogmann_idioms) { 
        const updatePayload = {};
        if (entry.additionalInfo) updatePayload.krogmann_info = entry.additionalInfo;
        if (entry.idioms) updatePayload.krogmann_idioms = entry.idioms;
        if (entry.references) updatePayload.notes = concept.notes ? `${concept.notes}\n[Krogmann Reference] ${entry.references}` : `[Krogmann Reference] ${entry.references}`;
        if (Object.keys(updatePayload).length > 0) {
            const { error } = await supabase.from('new_concepts').update(updatePayload).eq('id', concept.id);
            if (error) addLog('krogmann', `Failed to add Krogmann notes for ${concept.primary_german_label}: ${error.message}`, 'error');
            else globalResults.conceptsEnriched++;
        }
    }
    const { data: halunderTerm } = await supabase.from('new_terms').upsert({ term_text: entry.halunderWord, language: 'hal' }, { onConflict: 'term_text,language' }).select('id').single();
    if (halunderTerm) {
        globalResults.termsCreated++;
        const { error: linkError } = await supabase.from('new_concept_to_term').insert({
            concept_id: concept.id,
            term_id: halunderTerm.id,
            pronunciation: entry.pronunciation,
            gender: entry.gender,
            plural_form: entry.plural,
            alternative_forms: entry.alternativeForms,
            homonym_number: entry.homonymNumber,
            source_name: sourceName
        });
        if (linkError && linkError.code !== '23505') {
            addLog('krogmann', `Error linking term for ${concept.primary_german_label}: ${linkError.message}`, 'warning');
        }
    }
    if (entry.examples) for (const example of entry.examples) {
        await supabase.from('new_examples').insert({ concept_id: concept.id, halunder_sentence: example.halunder, german_sentence: example.german, note: example.note, source_name: sourceName });
        globalResults.examplesCreated++;
        perFileResults.examples++;
    }
    if (entry.relatedWords) {
        for (const relatedWord of entry.relatedWords) {
            relationsToProcess.push({
                sourceConceptId: concept.id,
                primaryGermanLabel: concept.primary_german_label,
                relatedWord: relatedWord
            });
        }
    }
}

async function processCSVData() {
    const state = processingStates.csv;
    try {
        addLog('csv', 'Starting CSV data processing', 'info');
        state.status = 'Reading CSV file...';
        const csvPath = path.join(__dirname, '..', 'public', 'miin_iaars_duusend_wurder.csv');
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
    const { data: concept } = await supabase.from('new_concepts').upsert({ primary_german_label: germanTerm, part_of_speech: 'noun' }, { onConflict: 'primary_german_label' }).select('id').single();
    if (concept) {
        results.conceptsCreated++;
        await supabase.from('new_terms').upsert({ term_text: germanTerm, language: 'de' }, { onConflict: 'term_text,language' });
        const { data: halunderTermData } = await supabase.from('new_terms').upsert({ term_text: halunderTerm, language: 'hal' }, { onConflict: 'term_text,language' }).select('id').single();
        results.termsCreated += 2;
        if (halunderTermData) {
            await supabase.from('new_concept_to_term').insert({ concept_id: concept.id, term_id: halunderTermData.id, source_name: 'miin_iaars_duusend' });
        }
    }
}

router.post('/clear-all', async (req, res) => {
    try {
        addLog('admin', 'Starting to clear all NEW dictionary data...', 'warning');
        await supabase.from('new_source_citations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('new_relations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('new_examples').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('new_concept_to_term').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('new_terms').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('new_concepts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('krogmann_uploads').update({ processed: false }).eq('processed', true);
        addLog('admin', 'All NEW dictionary data cleared and Krogmann uploads reset.', 'success');
        res.json({ success: true, message: 'All new dictionary data cleared' });
    } catch (error) {
        console.error('Clear data error:', error);
        addLog('admin', `Error clearing data: ${error.message}`, 'error');
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
