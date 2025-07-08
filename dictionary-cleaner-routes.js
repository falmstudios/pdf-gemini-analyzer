const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// === DATABASE CONNECTIONS ===
const mainDictionaryDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
// Note: sourceDbClient is not needed for this script, but we can leave it for future use.
const sourceDbClient = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);

const axiosInstance = axios.create({ timeout: 0 });

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
    console.log(`[DICT-CLEANER] [${type.toUpperCase()}] ${message}`);
}

async function callOpenAI_Api(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY environment variable not set.");
    const apiUrl = 'https://api.openai.com/v1/chat/completions';
    
    let attempts = 0;
    const maxAttempts = 4;
    let delay = 5000;

    while (attempts < maxAttempts) {
        try {
            const response = await axiosInstance.post(
                apiUrl,
                {
                    model: "o3-2025-04-16",
                    messages: [
                        { "role": "system", "content": "You are a helpful expert linguist. Your output must be a single, valid JSON object and nothing else." },
                        { "role": "user", "content": prompt }
                    ],
                    temperature: 0.7,
                    response_format: { "type": "json_object" }
                },
                { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` } }
            );

            if (response.data && response.data.choices && response.data.choices[0]) {
                return JSON.parse(response.data.choices[0].message.content);
            }
            throw new Error('Invalid response format from OpenAI API');
        } catch (error) {
            if (error.response && error.response.status === 429) {
                attempts++;
                if (attempts >= maxAttempts) {
                    addLog(`Max retry attempts reached for OpenAI API. Giving up.`, 'error');
                    throw new Error('OpenAI API rate limit exceeded after multiple retries.');
                }
                const jitter = Math.random() * 1000;
                const waitTime = delay + jitter;
                addLog(`OpenAI API rate limit hit. Retrying in ${Math.round(waitTime / 1000)}s... (Attempt ${attempts}/${maxAttempts})`, 'warning');
                await new Promise(resolve => setTimeout(resolve, waitTime));
                delay *= 2;
            } else {
                if (error.response) {
                    console.error("OpenAI API Error Response:", error.response.data);
                    throw new Error(`OpenAI API error: ${error.response.status} - ${JSON.stringify(error.response.data.error)}`);
                }
                throw error;
            }
        }
    }
}

// === THE MAIN PROCESSING FUNCTION ===
async function runDictionaryCleaner(limit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now() };
    let firstPromptPrinted = false;
    addLog(`Starting Dictionary Example Cleaner process...`, 'info');

    try {
        addLog("Checking for any stale 'processing' jobs...", 'info');
        await mainDictionaryDb.from('dictionary_examples').update({ cleaning_status: 'pending' }).eq('cleaning_status', 'processing');

        addLog(`Fetching up to ${limit} pending examples from the dictionary...`, 'info');
        // --- FIX IS HERE: Corrected the join syntax ---
        const { data: pendingExamples, error: fetchError } = await mainDictionaryDb
            .from('dictionary_examples')
            .select(`
                *,
                entry:dictionary_entries!entry_id(
                    german_word,
                    references:dictionary_references!entry_id(
                        reference_type,
                        target_entry:dictionary_entries!referenced_entry_id(german_word)
                    )
                )
            `)
            .eq('cleaning_status', 'pending')
            .not('halunder_sentence', 'is', null)
            .not('german_sentence', 'is', null)
            .limit(limit);
        // --- END OF FIX ---

        if (fetchError) throw new Error(`Failed to fetch examples: ${fetchError.message}`);
        if (!pendingExamples || pendingExamples.length === 0) {
            addLog('No pending examples found to clean.', 'success');
            processingState.status = 'Completed (No new examples)';
            processingState.isProcessing = false;
            return;
        }

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples to process.`, 'success');
        processingState.status = 'Cleaning examples with AI...';
        let processedCount = 0;

        for (const example of pendingExamples) {
            addLog(`Processing example ${processedCount + 1} of ${totalToProcess}...`, 'info');
            try {
                await processSingleExample(example, !firstPromptPrinted);
                if (!firstPromptPrinted) firstPromptPrinted = true;
            } catch (e) {
                addLog(`Failed to process example ID ${example.id}: ${e.message}`, 'error');
                await mainDictionaryDb.from('dictionary_examples').update({ cleaning_status: 'error' }).eq('id', example.id);
            }
            processedCount++;
            processingState.details = `Processed ${processedCount} of ${totalToProcess} examples.`;
            processingState.progress = totalToProcess > 0 ? (processedCount / totalToProcess) : 1;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        const processingTime = Math.round((Date.now() - processingState.startTime) / 1000);
        addLog(`Processing complete for this run in ${processingTime}s.`, 'success');
        processingState.status = 'Completed';

    } catch (error) {
        addLog(`A critical error occurred: ${error.message}`, 'error');
        processingState.status = 'Error';
        throw error;
    } finally {
        processingState.isProcessing = false;
    }
}

// === THE AI PIPELINE FOR A SINGLE EXAMPLE ===
async function processSingleExample(example, shouldPrintPrompt) {
    await mainDictionaryDb.from('dictionary_examples').update({ cleaning_status: 'processing' }).eq('id', example.id);

    const prompt = buildExampleCleanerPrompt(example);
    
    if (shouldPrintPrompt) {
        console.log('----------- DICTIONARY CLEANER PROMPT -----------');
        console.log(prompt);
        console.log('-------------------------------------------------');
        addLog('Printed full prompt to server console for verification.', 'info');
    }

    const aiResult = await callOpenAI_Api(prompt);

    const cleanedEntries = [];
    cleanedEntries.push({
        original_example_id: example.id,
        cleaned_halunder: aiResult.cleaned_halunder,
        cleaned_german: aiResult.best_translation,
        source: 'o3_best',
        confidence_score: aiResult.confidence_score,
        ai_notes: aiResult.notes
    });
    if (aiResult.alternative_translations) {
        aiResult.alternative_translations.forEach(alt => {
            cleanedEntries.push({
                original_example_id: example.id,
                cleaned_halunder: aiResult.cleaned_halunder,
                cleaned_german: alt.translation,
                source: 'o3_alternative',
                confidence_score: alt.confidence_score,
                ai_notes: alt.notes
            });
        });
    }

    const { error: insertError } = await mainDictionaryDb.from('cleaned_dictionary_examples').insert(cleanedEntries);
    if (insertError) throw new Error(`Failed to save cleaned example: ${insertError.message}`);

    await mainDictionaryDb.from('dictionary_examples').update({ cleaning_status: 'completed' }).eq('id', example.id);
    
    const logMessage = `[HAL-CLEANED] ${aiResult.cleaned_halunder} -> [DE] ${aiResult.cleaned_german}`;
    addLog(logMessage, 'success');
    
    return shouldPrintPrompt;
}

// === HELPER TO BUILD THE PROMPT ===
function buildExampleCleanerPrompt(example) {
    // Gracefully handle cases where the join might not have worked perfectly
    const headword = example.entry?.german_word || "Unknown";
    const relatedWords = example.entry?.references?.map(r => r.target_entry?.german_word).filter(Boolean) || [];

    return `
You are an expert linguist and data cleaner specializing in Heligolandic Frisian (Halunder) and German. Your task is to take a raw example sentence pair from a dictionary and normalize it into a high-quality, clean parallel sentence for machine learning.

**PRIMARY GOAL:**
Your main job is to "clean" both the Halunder and German sentences. This involves fixing obvious OCR errors (like misplaced line breaks, typos) and making the German translation sound natural and fluent, while explaining any idiomatic translations.

**INSTRUCTIONS:**
1.  **Analyze the Raw Pair:** Look at the provided Halunder and German example.
2.  **Correct the Halunder:** Create a clean, single-line version of the Halunder sentence. Fix OCR errors like "letj\\ninaptain" to "letj inaptain". **Do not change the original wording or grammar.**
3.  **Correct & Improve the German:** Create the best possible German translation. It should be grammatically correct and sound natural to a native speaker. You can and should change the wording from the raw German example if it improves fluency.
4.  **Explain Idioms:** In the "notes" field, explain *why* the translation is what it is, especially if it's not literal. For example, if 'keen Read tu ween' is translated as 'keinen Ausweg geben', explain that this is an idiomatic translation. Use the provided context (Headword, Related Words, Notes) to inform your explanation.
5.  **Provide Alternatives:** If other valid, high-quality German translations exist, provide them.
6.  **Output JSON:** Structure your entire response in the following JSON format ONLY.

**INPUT DATA:**

**1. Dictionary Headword (The context this example belongs to):**
"${headword}"

**2. Related Words for Context:**
${JSON.stringify(relatedWords)}

**3. Raw Example Pair (may contain errors):**
- Halunder: "${example.halunder_sentence}"
- German: "${example.german_sentence}"

**4. Original Note on the Example (if any):**
"${example.context_note || 'N/A'}"

**YOUR JSON OUTPUT:**
\`\`\`json
{
  "cleaned_halunder": "The corrected, single-line version of the Halunder sentence.",
  "best_translation": "The best, most natural German translation.",
  "confidence_score": 0.95,
  "notes": "Explain why the translation is what it is. For example: 'The phrase X is an idiom meaning Y, so it was translated this way for naturalness.'",
  "alternative_translations": [
    {
      "translation": "A valid alternative translation.",
      "confidence_score": 0.80,
      "notes": "This is a more literal translation."
    }
  ]
}
\`\`\`
`;
}

// === API ROUTES ===
router.post('/start-cleaning', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    const limit = parseInt(req.body.limit, 10) || 100;
    runDictionaryCleaner(limit).catch(err => {
        console.error("Caught unhandled error in dictionary cleaner:", err);
    });
    res.json({ success: true, message: `Dictionary cleaning started for up to ${limit} examples.` });
});

router.get('/progress', (req, res) => {
    res.json(processingState);
});

module.exports = router;
