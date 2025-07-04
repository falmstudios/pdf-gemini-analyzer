const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// === DATABASE CONNECTIONS ===
const sourceDbClient = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);
const dictionaryDbClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// === STATE MANAGEMENT ===
let processingState = {
    isProcessing: false,
    progress: 0,
    status: 'Idle',
    details: '',
    logs: [],
    startTime: null
};

function addLog(message, type = 'info') {
    const log = { id: Date.now() + Math.random(), message, type, timestamp: new Date().toISOString() };
    processingState.logs.push(log);
    if (processingState.logs.length > 1000) processingState.logs.shift();
    console.log(`[CORPUS-BUILDER] [${type.toUpperCase()}] ${message}`);
}

// === THE MAIN PROCESSING FUNCTION ===
async function runCorpusBuilder(textLimit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now() };
    addLog(`Starting corpus build process. Text limit: ${textLimit}`, 'info');

    try {
        // --- STAGE 1: EXTRACT & SEGMENT ---
        addLog('Fetching texts from source database...', 'info');
        const { data: texts, error: fetchError } = await sourceDbClient
            .from('texts')
            .select('id, complete_helgolandic_text')
            .or('review_status.eq.pending,review_status.eq.halunder_only')
            .limit(textLimit);

        if (fetchError) throw new Error(`Source DB fetch error: ${fetchError.message}`);
        if (!texts || texts.length === 0) {
            addLog('No pending texts found to process.', 'success');
            processingState.status = 'Completed (No new texts)';
            processingState.isProcessing = false;
            return;
        }
        
        addLog(`Found ${texts.length} texts to process.`, 'success');
        processingState.status = 'Extracting and segmenting sentences...';
        
        const allSentences = [];
        for (const text of texts) {
            const sentences = text.complete_helgolandic_text.match(/[^.?!]+[.?!]+|[^.?!]+$/g) || [];
            sentences.forEach((s, index) => {
                const trimmedSentence = s.trim();
                if (trimmedSentence) {
                    allSentences.push({
                        text_id: text.id,
                        sentence_number: index + 1,
                        halunder_sentence: trimmedSentence
                    });
                }
            });
            await sourceDbClient.from('texts').update({ review_status: 'processing_halunder_only' }).eq('id', text.id);
        }

        addLog(`Extracted a total of ${allSentences.length} sentences. Inserting into source database...`, 'info');
        const { error: insertError } = await sourceDbClient.from('source_sentences').insert(allSentences);
        if (insertError) throw new Error(`Failed to insert sentences: ${insertError.message}`);
        addLog('All sentences saved successfully.', 'success');
        
        // --- STAGE 2: PROCESS SENTENCES WITH AI ---
        processingState.status = 'Processing sentences with AI...';
        let processedCount = 0;
        
        // Re-fetch the sentences we just inserted to process them
        const { data: pendingSentences, error: pendingError } = await sourceDbClient
            .from('source_sentences')
            .select('*')
            .in('text_id', texts.map(t => t.id)) // Only process sentences from the texts we just fetched
            .eq('processing_status', 'pending');

        if (pendingError) throw new Error(`Could not fetch pending sentences: ${pendingError.message}`);
        
        const totalToProcess = pendingSentences.length;

        for (const sentence of pendingSentences) {
            processingState.details = `Processing sentence ${processedCount + 1} of ${totalToProcess}`;
            processingState.progress = processedCount / totalToProcess;
            
            try {
                await processSingleSentence(sentence);
            } catch (e) {
                addLog(`Failed to process sentence ID ${sentence.id}: ${e.message}`, 'error');
                await sourceDbClient.from('source_sentences').update({ processing_status: 'error', error_message: e.message }).eq('id', sentence.id);
            }
            processedCount++;
        }
        
        const processingTime = Math.round((Date.now() - processingState.startTime) / 1000);
        addLog(`Processing complete in ${processingTime}s.`, 'success');
        processingState.status = 'Completed';

    } catch (error) {
        addLog(`A critical error occurred: ${error.message}`, 'error');
        processingState.status = 'Error';
        throw error;
    } finally {
        processingState.isProcessing = false;
    }
}

// === THE AI PIPELINE FOR A SINGLE SENTENCE ===
async function processSingleSentence(sentence) {
    await sourceDbClient.from('source_sentences').update({ processing_status: 'processing' }).eq('id', sentence.id);

    // 1. Get RunPod Translations
    const runpodResponse = await fetch('https://api.runpod.ai/v2/wyg1vwde9yva0y/runsync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}` },
        body: JSON.stringify({ input: { text: sentence.halunder_sentence, num_alternatives: 3 } })
    });
    if (!runpodResponse.ok) throw new Error('RunPod API failed.');
    const runpodData = await runpodResponse.json();
    const runpodTranslations = runpodData.output?.translations || [];
    await sourceDbClient.from('source_sentences').update({ runpod_translations: runpodTranslations }).eq('id', sentence.id);

    // 2. Get Dictionary Data
    const words = [...new Set(sentence.halunder_sentence.toLowerCase().match(/[\p{L}0-9]+/gu) || [])];
    const { data: dictData, error: dictError } = await dictionaryDbClient
        .from('terms')
        .select(`term_text, concept_to_term!inner(concept:concepts!inner(primary_german_label, part_of_speech, german_definition))`)
        .filter('term_text', 'ilike.any', `{${words.join(',')}}`)
        .eq('language', 'hal');
    if (dictError) addLog(`Dictionary lookup failed: ${dictError.message}`, 'warning');

    // 3. Get Context Sentences
    const { data: contextSentences } = await sourceDbClient
        .from('source_sentences')
        .select('halunder_sentence')
        .eq('text_id', sentence.text_id)
        .order('sentence_number')
        .range(sentence.sentence_number - 3, sentence.sentence_number + 1);

    // 4. Construct and Call Gemini
    const prompt = buildGeminiPrompt(sentence.halunder_sentence, contextSentences, runpodTranslations, dictData);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().replace(/^```json\s*|```$/g, '');
    const geminiResult = JSON.parse(responseText);

    // 5. Save Results to Corpus
    const corpusEntries = [];
    corpusEntries.push({
        source_sentence_id: sentence.id,
        halunder_sentence: sentence.halunder_sentence,
        german_translation: geminiResult.best_translation,
        source: 'gemini_best',
        confidence_score: geminiResult.confidence_score,
        notes: geminiResult.notes
    });
    if (geminiResult.alternative_translations) {
        geminiResult.alternative_translations.forEach(alt => {
            corpusEntries.push({
                source_sentence_id: sentence.id,
                halunder_sentence: sentence.halunder_sentence,
                german_translation: alt.translation,
                source: 'gemini_alternative',
                confidence_score: alt.confidence_score,
                notes: alt.notes
            });
        });
    }

    // --- FIX IS HERE: Using the new table name 'ai_translated_corpus' ---
    const { error: corpusInsertError } = await sourceDbClient.from('ai_translated_corpus').insert(corpusEntries);
    if (corpusInsertError) throw new Error(`Failed to save to corpus: ${corpusInsertError.message}`);

    await sourceDbClient.from('source_sentences').update({ processing_status: 'completed' }).eq('id', sentence.id);
    addLog(`Successfully processed sentence ID: ${sentence.id}`, 'success');
}

// === HELPER TO BUILD THE PROMPT ===
function buildGeminiPrompt(targetSentence, context, proposals, dictionary) {
    return `
You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to create a perfect German translation for a given Halunder sentence, creating a high-quality parallel corpus for machine learning.

**INSTRUCTIONS:**
1.  Analyze the **Target Halunder Sentence**.
2.  Use the **Sentence Context** to understand the surrounding conversation.
3.  Review the **Machine Translation Proposals** as a starting point. They might be flawed.
4.  Consult the **Dictionary Entries** to understand the literal meaning of each word.
5.  Synthesize all this information to create the most natural-sounding and contextually accurate German translation. Prioritize natural German over a literal, word-for-word translation. Halunder is highly idiomatic.
6.  Provide one "best" translation and, if valid alternatives exist, list them separately.
7.  Provide a confidence score for each translation.
8.  Output your response in the following JSON format ONLY. Do not include any other text or explanations.

**INPUT DATA:**

**1. Sentence Context:**
\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

**2. Target Halunder sentence:**
"${targetSentence}"

**3. Machine Translation Proposals (from RunPod):**
\`\`\`json
${JSON.stringify(proposals, null, 2)}
\`\`\`

**4. Dictionary Entries for words in the target sentence:**
\`\`\`json
${JSON.stringify(dictionary, null, 2)}
\`\`\`

**YOUR JSON OUTPUT:**
\`\`\`json
{
  "best_translation": "This is your single best and most natural German translation.",
  "confidence_score": 0.95,
  "notes": "Explain briefly why you chose this translation, e.g., 'Chose this phrasing because the Halunder is an idiom for...'",
  "alternative_translations": [
    {
      "translation": "This is a valid, but slightly less common or more literal alternative.",
      "confidence_score": 0.80,
      "notes": "This is a more literal translation."
    }
  ]
}
\`\`\`
`;
}

// === API ROUTES ===
router.post('/start-processing', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    const limit = parseInt(req.body.limit, 10) || 10;
    runCorpusBuilder(limit).catch(err => {
        console.error("Caught unhandled error in corpus builder:", err);
    });
    res.json({ success: true, message: `Processing started for up to ${limit} texts.` });
});

router.get('/progress', (req, res) => {
    res.json(processingState);
});

module.exports = router;
