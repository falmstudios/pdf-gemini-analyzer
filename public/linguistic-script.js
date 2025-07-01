let isProcessing = false;
let currentLogs = [];

// Load stats on page load
window.onload = async function() {
    await refreshStats();
};

// Refresh statistics
async function refreshStats() {
    try {
        const response = await fetch('/linguistic/stats');
        const stats = await response.json();
        
        document.getElementById('stats-loading').style.display = 'none';
        document.getElementById('stats-content').style.display = 'block';
        
        document.getElementById('linguistic-count').textContent = stats.linguisticFeatures.toLocaleString();
        document.getElementById('translation-count').textContent = stats.translationAids.toLocaleString();
        document.getElementById('total-count').textContent = stats.total.toLocaleString();
        document.getElementById('processed-count').textContent = stats.processed.toLocaleString();
        
    } catch (error) {
        addLog('Error loading statistics: ' + error.message, 'error');
    }
}

// Start cleaning process
async function startCleaning() {
    if (isProcessing) {
        alert('Processing is already in progress!');
        return;
    }
    
    const processLinguistic = document.getElementById('process-linguistic').checked;
    const processTranslation = document.getElementById('process-translation').checked;
    const batchSize = parseInt(document.getElementById('batch-size').value);
    
    if (!processLinguistic && !processTranslation) {
        alert('Please select at least one data source to process!');
        return;
    }
    
    isProcessing = true;
    document.getElementById('start-btn').disabled = true;
    document.getElementById('progress-panel').style.display = 'block';
    document.getElementById('results-panel').style.display = 'none';
    
    try {
        const response = await fetch('/linguistic/start-cleaning', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                processLinguistic,
                processTranslation,
                batchSize
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to start cleaning process');
        }
        
        const result = await response.json();
        addLog('Cleaning process started', 'success');
        
        // Start monitoring progress
        monitorProgress();
        
    } catch (error) {
        addLog('Error starting cleaning: ' + error.message, 'error');
        isProcessing = false;
        document.getElementById('start-btn').disabled = false;
    }
}

// Monitor progress
async function monitorProgress() {
    try {
        const response = await fetch('/linguistic/progress');
        const progress = await response.json();
        
        // Update progress bar
        const percentage = progress.percentage || 0;
        document.getElementById('progress-fill').style.width = percentage + '%';
        document.getElementById('progress-text').textContent = progress.status || 'Processing...';
        document.getElementById('progress-details').textContent = progress.details || '';
        
        // Add new logs
        if (progress.logs) {
            progress.logs.forEach(log => {
                if (!currentLogs.find(l => l.id === log.id)) {
                    currentLogs.push(log);
                    addLogEntry(log);
                }
            });
        }
        
        // Check if completed
        if (progress.completed) {
            isProcessing = false;
            document.getElementById('start-btn').disabled = false;
            showResults(progress.results);
            await refreshStats();
        } else {
            // Continue monitoring
            setTimeout(monitorProgress, 2000);
        }
        
    } catch (error) {
        addLog('Error monitoring progress: ' + error.message, 'error');
        isProcessing = false;
        document.getElementById('start-btn').disabled = false;
    }
}

// Show results
function showResults(results) {
    document.getElementById('results-panel').style.display = 'block';
    
    const html = `
        <div class="result-item">
            <span class="result-label">Total Records Processed:</span>
            <span class="result-value">${results.totalProcessed}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Unique Entries Created:</span>
            <span class="result-value">${results.uniqueEntries}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Duplicates Found:</span>
            <span class="result-value">${results.duplicatesFound}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Processing Time:</span>
            <span class="result-value">${results.processingTime}</span>
        </div>
    `;
    
    document.getElementById('results-content').innerHTML = html;
}

// Add log entry
function addLog(message, type = 'info') {
    const log = {
        id: Date.now() + Math.random(),
        message,
        type,
        timestamp: new Date().toISOString()
    };
    addLogEntry(log);
}

function addLogEntry(log) {
    const consoleDiv = document.getElementById('console');
    const logEntry = document.createElement('div');
    logEntry.className = `console-entry ${log.type}`;
    
    const timestamp = new Date(log.timestamp).toLocaleTimeString();
    logEntry.innerHTML = `<span class="timestamp">[${timestamp}]</span> ${log.message}`;
    
    consoleDiv.appendChild(logEntry);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
}

// Clear logs
function clearLogs() {
    currentLogs = [];
    document.getElementById('console').innerHTML = '';
    addLog('Logs cleared', 'info');
}
