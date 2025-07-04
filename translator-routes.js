const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Use the correct, unified environment variables
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// The main route that does all the work
router.post('/analyze-and-translate', async (req, res) => {
    const { sentence } = req.body;

    if (!sentence) {
        return res.status(400).json({ error: 'Sentence is required.' });
    }

    try {
        // This part is correct - it normalizes the input to lowercase
        const words = [...new Set(sentence.toLowerCase().match(/[\p{L}0-9]+/gu) || [])];
        let wordAnalysis = [];

        if (words.length > 0) {
            
            // --- THE DEFINITIVE FIX ---
            // We build a dynamic OR filter for case-insensitive matching.
            const orFilterConditions = words.map(word => `term_text.ilike.${word}`).join(',');
            
            const dictionaryPromise = supabase
                .from('terms')
                .select(`
                    term_text,
                    concept_to_term!inner(
                        pronunciation, gender, plural_form, etymology, homonym_number, note, source_name, alternative_forms,
                        concept:concepts!inner(
                            id, primary_german_label, part_of_speech, notes, german_definition, krogmann_info, krogmann_idioms, sense_id, sense_number,
                            examples (halunder_sentence, german_sentence, note, example_type),
                            source_relations:relations!source_concept_id (relation_type, note, target_concept:concepts!target_concept_id (id, primary_german_label)),
                            source_citations (citation_text)
                        )
                    )
                `)
                // Apply the OR filter for the words AND the language filter
                .or(orFilterConditions)
                .eq('language', 'hal');
                
            // The featuresPromise also needs to be case-insensitive
            const featuresOrFilter = words.map(word => `halunder_term.ilike.${word}`).join(',');
            const featuresPromise = supabase
                .from('cleaned_linguistic_examples')
                .select('halunder_term, explanation, feature_type')
                .or(featuresOrFilter);
                
            const [dictionaryResults, featuresResults] = await Promise.all([dictionaryPromise, featuresPromise]);

            if (dictionaryResults.error) throw new Error(`Dictionary search error: ${dictionaryResults.error.message}`);
            if (featuresResults.error) throw new Error(`Linguistic features search error: ${featuresResults.error.message}`);
            
            // The data processing logic is correct, but we must ensure keys are lowercase
            const dictionaryMap = new Map();
            if (dictionaryResults.data) {
                dictionaryResults.data.forEach(termResult => {
                    // Use .toLowerCase() on the key to match our input `words` array
                    const halunderWord = termResult.term_text.toLowerCase(); 
                    if (!dictionaryMap.has(halunderWord)) {
                        dictionaryMap.set(halunderWord, []);
                    }

                    termResult.concept_to_term.forEach(connection => {
                        const concept = connection.concept;
                        if (!concept) return;

                        const translationMap = new Map();
                        translationMap.set(termResult.term_text, {
                            term: termResult.term_text,
                            pronunciation: connection.pronunciation,
                            gender: connection.gender,
                            plural: connection.plural_form,
                            etymology: connection.etymology,
                            note: connection.note,
                            alternativeForms: connection.alternative_forms,
                            sources: [connection.source_name]
                        });
                        
                        const formattedEntry = {
                            id: concept.id,
                            headword: concept.primary_german_label,
                            partOfSpeech: concept.part_of_speech,
                            germanDefinition: concept.german_definition,
                            ahrhammarNotes: concept.notes,
                            krogmannInfo: concept.krogmann_info,
                            krogmannIdioms: concept.krogmann_idioms,
                            senseId: concept.sense_id,
                            senseNumber: concept.sense_number,
                            translations: Array.from(translationMap.values()),
                            examples: concept.examples.map(ex => ({ halunder: ex.halunder_sentence, german: ex.german_sentence, note: ex.note, type: ex.example_type })),
                            relations: (concept.source_relations || []).map(rel => ({ type: rel.relation_type.replace(/_/g, ' '), targetTerm: rel.target_concept.primary_german_label, targetId: rel.target_concept.id, note: rel.note })),
                            citations: (concept.source_citations || []).map(c => c.citation_text)
                        };
                        dictionaryMap.get(halunderWord).push(formattedEntry);
                    });
                });
            }

            const featuresMap = new Map((featuresResults.data || []).map(item => [item.halunder_term.toLowerCase(), item]));

            wordAnalysis = words.map(word => ({
                word: word,
                dictionaryEntries: dictionaryMap.get(word) || [],
                linguisticFeature: featuresMap.get(word) || null
            }));
        }

        // --- 2. EXTERNAL API TRANSLATION (Unchanged) ---
        const apiUrl = 'https://api.runpod.ai/v2/wyg1vwde9yva0y/runsync';
        const apiKey = process.env.RUNPOD_API_KEY;

        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ input: { text: sentence, num_alternatives: 3 } })
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
