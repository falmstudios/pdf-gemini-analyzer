const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Use the same Supabase client as your other routes
const supabase = createClient(
    process.env.SOURCE_SUPABASE_URL,
    process.env.SOURCE_SUPABASE_ANON_KEY
);

// The main route that does all the work
router.post('/analyze-and-translate', async (req, res) => {
    const { sentence } = req.body;

    if (!sentence) {
        return res.status(400).json({ error: 'Sentence is required.' });
    }

    try {
        // --- 1. WORD-BY-WORD ANALYSIS ---
        // Sanitize and get unique words from the sentence
        const words = [...new Set(sentence.toLowerCase().match(/\b(\w+)\b/g) || [])];
        let wordAnalysis = [];

        if (words.length > 0) {
            // Fetch from both tables concurrently for speed
            const dictionaryPromise = supabase
                .from('terms')
                .select('term_text, concepts(primary_german_label)')
                .in('term_text', words)
                .eq('language', 'hal');

            const featuresPromise = supabase
                .from('cleaned_linguistic_examples')
                .select('halunder_term, explanation, feature_type')
                .in('halunder_term', words);

            const [dictionaryResults, featuresResults] = await Promise.all([dictionaryPromise, featuresPromise]);

            if (dictionaryResults.error) throw new Error(`Dictionary search error: ${dictionaryResults.error.message}`);
            if (featuresResults.error) throw new Error(`Linguistic features search error: ${featuresResults.error.message}`);

            // Create maps for quick lookups
            const dictionaryMap = new Map(dictionaryResults.data.map(item => [item.term_text.toLowerCase(), item.concepts.primary_german_label]));
            const featuresMap = new Map(featuresResults.data.map(item => [item.halunder_term.toLowerCase(), item]));

            // Combine the results
            wordAnalysis = words.map(word => ({
                word: word,
                dictionaryMeaning: dictionaryMap.get(word) || null,
                linguisticFeature: featuresMap.get(word) || null
            }));
        }

        // --- 2. EXTERNAL API TRANSLATION ---
        const apiUrl = 'https://api.runpod.ai/v2/wyg1vwde9yva0y/runsync';
        const apiKey = process.env.RUNPOD_API_KEY;

        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                input: {
                    text: sentence,
                    num_alternatives: 3
                }
            })
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.text();
            throw new Error(`Translation API failed with status ${apiResponse.status}: ${errorBody}`);
        }

        const translationData = await apiResponse.json();

        // --- 3. SEND COMBINED RESPONSE ---
        res.json({
            wordAnalysis: wordAnalysis,
            apiTranslation: translationData
        });

    } catch (error) {
        console.error('Translation/Analysis Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
