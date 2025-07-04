document.addEventListener('DOMContentLoaded', () => {
    const translateBtn = document.getElementById('translate-btn');
    const sentenceInput = document.getElementById('halunder-sentence');
    const statusDiv = document.getElementById('status');
    const analysisResultsDiv = document.getElementById('word-analysis-results');
    const analysisGrid = document.getElementById('analysis-grid');
    const apiResultsDiv = document.getElementById('api-translation-results');
    const translationOutput = document.getElementById('translation-output');

    translateBtn.addEventListener('click', handleTranslation);
    sentenceInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleTranslation();
    });

    async function handleTranslation() {
        // ... (this part is the same as before)
        const sentence = sentenceInput.value.trim();
        if (!sentence) {
            alert('Please enter a sentence.');
            return;
        }
        statusDiv.textContent = 'Analyzing and translating... Please wait.';
        statusDiv.style.color = '#555';
        analysisResultsDiv.style.display = 'none';
        apiResultsDiv.style.display = 'none';
        translateBtn.disabled = true;

        try {
            const response = await fetch('/translator/analyze-and-translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sentence })
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'An unknown server error occurred.');
            }
            const data = await response.json();
            displayWordAnalysis(data.wordAnalysis);
            displayApiTranslation(data.apiTranslation);
            statusDiv.textContent = 'Analysis complete.';
            statusDiv.style.color = 'green';
        } catch (error) {
            statusDiv.textContent = `Error: ${error.message}`;
            statusDiv.style.color = 'red';
            console.error('Fetch error:', error);
        } finally {
            translateBtn.disabled = false;
        }
    }

    function displayWordAnalysis(analysisData) {
        if (!analysisData || analysisData.length === 0) {
            analysisGrid.innerHTML = '<p>No dictionary entries found for words in this sentence.</p>';
        } else {
            // --- NEW RENDERING LOGIC ---
            analysisGrid.innerHTML = analysisData.map(wordData => {
                let featureHtml = '';
                if (wordData.linguisticFeature) {
                    const feature = wordData.linguisticFeature;
                    featureHtml = `
                        <div class="feature-box">
                            <strong>Linguistic Feature:</strong>
                            <div class="feature">
                                <strong class="type">${feature.feature_type}</strong>
                                <p>${feature.explanation}</p>
                            </div>
                        </div>
                    `;
                }
                
                let entriesHtml = '<p><em>No full dictionary entry found.</em></p>';
                if (wordData.dictionaryEntries && wordData.dictionaryEntries.length > 0) {
                    // For each word, render all its associated dictionary entries
                    entriesHtml = wordData.dictionaryEntries.map(entry => createEntryHTML(entry)).join('');
                }

                return `
                    <div class="word-card">
                        <div class="halunder-header">${wordData.word}</div>
                        ${featureHtml}
                        <div class="dictionary-entries-container">
                            ${entriesHtml}
                        </div>
                    </div>
                `;
            }).join('');
        }
        analysisResultsDiv.style.display = 'block';
    }
    
    // ... (displayApiTranslation is the same)
    function displayApiTranslation(apiData) {
        if (apiData && apiData.output) {
            translationOutput.textContent = JSON.stringify(apiData.output, null, 2);
        } else if (apiData && apiData.error) {
            translationOutput.textContent = `API Error: ${apiData.error}`;
        } else {
            translationOutput.textContent = 'No translation returned from the API.';
        }
        apiResultsDiv.style.display = 'block';
    }

    // --- HELPER FUNCTIONS COPIED/ADAPTED FROM dictionary-viewer.js ---
    // These functions will render the full dictionary entry consistently
    
    function createEntryHTML(entry) {
        const formatNotes = (notes) => notes ? notes.replace(/\n/g, '<br>').replace(/---/g, '<hr class="note-separator">') : '';

        return `
            <div class="entry expanded" data-entry-id="${entry.id}">
                <div class="entry-header">
                    <span class="headword">${entry.headword}</span>
                    ${entry.partOfSpeech ? `<span class="part-of-speech">${entry.partOfSpeech}</span>` : ''}
                    ${entry.senseNumber ? `<span class="sense-number">Sense ${entry.senseNumber}</span>` : ''}
                </div>
                <div class="entry-details">
                    ${entry.germanDefinition ? `<div class="detail-section"><h4>Definition</h4><p>${entry.germanDefinition}</p></div>` : ''}
                    ${entry.ahrhammarNotes ? `<div class="detail-section"><h4>Usage Notes (Ahrhammar)</h4><p>${formatNotes(entry.ahrhammarNotes)}</p></div>` : ''}
                    ${entry.krogmannInfo ? `<div class="detail-section"><h4>Additional Info (Krogmann)</h4><p>${formatNotes(entry.krogmannInfo)}</p></div>` : ''}
                    ${entry.krogmannIdioms ? `<div class="detail-section"><h4>Idioms (Krogmann)</h4><p>${formatNotes(entry.krogmannIdioms)}</p></div>` : ''}

                    ${createTranslationsHTML(entry.translations)}
                    ${createExamplesHTML(entry.examples)}
                    ${createRelationsHTML(entry.relations)}
                    ${createCitationsHTML(entry.citations)}
                </div>
            </div>
        `;
    }

    function createTranslationsHTML(translations) {
        if (!translations || translations.length === 0) return '';
        return `<div class="detail-section"><h4>Halunder Translations</h4>${translations.map(trans => `<div class="translation-item"><span class="hal-term">${trans.term}</span> ${trans.pronunciation ? `<span class="pronunciation">[${trans.pronunciation}]</span>` : ''} ${trans.gender ? `<span class="gender ${trans.gender}">${trans.gender}</span>` : ''} ${trans.plural ? `<span class="plural">pl. ${trans.plural}</span>` : ''} ${trans.note ? `<div class="translation-note">${trans.note}</div>` : ''} ${trans.etymology ? `<div class="etymology">Etymology: ${trans.etymology}</div>` : ''} ${trans.alternativeForms && trans.alternativeForms.length > 0 ? `<div class="alternative-forms">Alt: ${trans.alternativeForms.join(', ')}</div>` : ''} ${trans.sources ? `<div class="sources">Sources: ${trans.sources.join(', ')}</div>` : ''}</div>`).join('')}</div>`;
    }

    function createExamplesHTML(examples) {
        if (!examples || examples.length === 0) return '';
        return `<div class="detail-section"><h4>Examples</h4>${examples.map(ex => `<div class="example-item">${ex.type ? `<span class="example-type">${ex.type.replace(/_/g, ' ')}</span>` : ''} ${ex.halunder ? `<div class="example-hal">${ex.halunder}</div>` : ''} ${ex.german ? `<div class="example-de">"${ex.german}"</div>` : ''} ${ex.note ? `<div class="example-note">(${ex.note})</div>` : ''}</div>`).join('')}</div>`;
    }

    function createRelationsHTML(relations) {
        if (!relations || relations.length === 0) return '';
        return `<div class="detail-section relations"><h4>See also</h4>${relations.map(rel => `<span class="relation-item"><span class="relation-type">${rel.type}:</span> <a href="#" class="relation-link" onclick="alert('Searching from here is not implemented yet.')">${rel.targetTerm}</a> ${rel.note ? `<span>(${rel.note})</span>` : ''}</span>`).join('')}</div>`;
    }

    function createCitationsHTML(citations) {
        if (!citations || citations.length === 0) return '';
        return `<div class="detail-section citations"><h4>Source Citations</h4><ul>${citations.map(cit => `<li>${cit}</li>`).join('')}</ul></div>`;
    }
});
