document.addEventListener('DOMContentLoaded', () => {
    const translateBtn = document.getElementById('translate-btn');
    const sentenceInput = document.getElementById('halunder-sentence');
    const statusDiv = document.getElementById('status');
    const analysisResultsDiv = document.getElementById('word-analysis-results');
    const analysisGrid = document.getElementById('analysis-grid');
    const apiResultsDiv = document.getElementById('api-translation-results');
    const translationOutput = document.getElementById('translation-output');

    translateBtn.addEventListener('click', handleTranslation);

    async function handleTranslation() {
        const sentence = sentenceInput.value.trim();
        if (!sentence) {
            alert('Please enter a sentence.');
            return;
        }

        // Reset UI and show loading state
        statusDiv.textContent = 'Analyzing and translating... Please wait.';
        statusDiv.style.color = '#555';
        analysisResultsDiv.style.display = 'none';
        apiResultsDiv.style.display = 'none';
        translateBtn.disabled = true;

        try {
            const response = await fetch('/translator/analyze-and-translate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sentence: sentence })
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
            analysisGrid.innerHTML = analysisData.map(wordData => {
                let featureHtml = '';
                if (wordData.linguisticFeature) {
                    const feature = wordData.linguisticFeature;
                    featureHtml = `
                        <div class="feature">
                            <strong class="type">${feature.feature_type}</strong>
                            <p>${feature.explanation}</p>
                        </div>
                    `;
                }

                return `
                    <div class="word-card">
                        <div class="halunder">${wordData.word}</div>
                        <div class="german">${wordData.dictionaryMeaning || '<em>No dictionary entry</em>'}</div>
                        ${featureHtml}
                    </div>
                `;
            }).join('');
        }
        analysisResultsDiv.style.display = 'block';
    }

    function displayApiTranslation(apiData) {
        if (apiData && apiData.output) {
             // Display the full raw JSON response beautifully formatted
            translationOutput.textContent = JSON.stringify(apiData.output, null, 2);
        } else if (apiData && apiData.error) {
            translationOutput.textContent = `API Error: ${apiData.error}`;
        } else {
            translationOutput.textContent = 'No translation returned from the API.';
        }
        apiResultsDiv.style.display = 'block';
    }
});
