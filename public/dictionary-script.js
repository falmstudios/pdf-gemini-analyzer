let isProcessing = false;
let currentLogs = [];

// Load stats on page load
window.onload = async function() {
    await refreshStats();
};

// Refresh statistics
async function refreshStats() {
    try {
        const response = await fetch('/dictionary/stats');
        const stats = await response.json();
        
        document.getElementById('stats-loading').style.display = 'none';
        document.getElementById('stats-content').style.display = 'block';
        
        document.getElementById('ahrhammar-count').textContent = stats.ahrhammarCount.toLocaleString();
        document.getElementById('krogmann-count').textContent = stats.krogmannCount.toLocaleString();
        document.getElementById('csv-count').textContent = stats.csvCount.toLocaleString();
        document.getElementById('concepts-count').textContent = stats.conceptsCount.toLocaleString();
        document.getElementById('terms-count').textContent = stats.termsCount.toLocaleString();
        
        // Enable buttons based on what's available
        if (stats.ahrhammarCount > 0) {
            document.getElementById('process-ahrhammar-btn').disabled = false;
        }
        if (stats.krogmannCount > 0 && stats.conceptsCount > 0) {
            document.getElementById('process-krogmann-btn').disabled = false;
        }
        if (stats.csvCount > 0 && stats.conceptsCount > 0) {
            document.getElementById('process-csv-btn').disabled = false;
        }
        
    } catch (error) {
        addLog('Error loading statistics: ' + error.message, 'error');
    }
}

// Upload Krogmann files
async function uploadKrogmannFiles() {
    const fileInput = document.getElementById('krogmannFiles');
    const files = fileInput.files;
    
    if (files.length === 0) {
        alert('Please select Krogmann JSON files to upload');
        return;
    }
    
    document.getElementById('upload-status').textContent = 'Uploading files...';
    
    let uploaded = 0;
    let errors = 0;
    
    for (let file of files) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            
            const response = await fetch('/dictionary/upload-krogmann', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: file.name,
                    data: data
                })
            });
            
            if (response.ok) {
                uploaded++;
                addLog(`Uploaded ${file.name}`, 'success');
            } else {
                errors++;
                addLog(`Failed to upload ${file.name}`, 'error');
            }
            
        } catch (error) {
            errors++;
            addLog(`Error processing ${file.name}: ${error.message}`, 'error');
        }
    }
    
    document.getElementById('upload-status').textContent = 
        `Upload complete: ${uploaded} successful, ${errors} errors`;
    
    fileInput.value = '';
    await refreshStats();
}

// Process Ahrhammar data
async function processAhrhammar() {
    if (isProcessing) {
        alert('Processing is already in progress!');
        return;
    }
    
    if (!confirm('This will process all Ahrhammar entries from the PDF analyses. Continue?')) {
        return;
    }
    
    isProcessing = true;
    document.getElementById('process-ahrhammar-btn').disabled = true;
    document.getElementById('progress-panel').style.display = 'block';
    document.getElementById('results-panel').style.display = 'none';
    
    try {
        const response = await fetch('/dictionary/process-ahrhammar', {
            method: 'POST'
        });
        
        if (!response.ok) {
            throw new Error('Failed to start Ahrhammar processing');
        }
        
        addLog('Started processing Ahrhammar data', 'success');
        monitorProgress('ahrhammar');
        
    } catch (error) {
        addLog('Error starting Ahrhammar processing: ' + error.message, 'error');
        isProcessing = false;
        document.getElementById('process-ahrhammar-btn').disabled = false;
    }
}

// Process Krogmann data
async function processKrogmann() {
    if (isProcessing) {
        alert('Processing is already in progress!');
        return;
    }
    
    if (!confirm('This will process all Krogmann entries and enrich existing concepts. Continue?')) {
        return;
    }
    
    isProcessing = true;
    document.getElementById('process-krogmann-btn').disabled = true;
    document.getElementById('progress-panel').style.display = 'block';
    document.getElementById('results-panel').style.display = 'none';
    
    try {
        const response = await fetch('/dictionary/process-krogmann', {
            method: 'POST'
        });
        
        if (!response.ok) {
            throw new Error('Failed to start Krogmann processing');
        }
        
        addLog('Started processing Krogmann data', 'success');
        monitorProgress('krogmann');
        
    } catch (error) {
        addLog('Error starting Krogmann processing: ' + error.message, 'error');
        isProcessing = false;
        document.getElementById('process-krogmann-btn').disabled = false;
    }
}

// Process CSV data
async function processCSV() {
    if (isProcessing) {
        alert('Processing is already in progress!');
        return;
    }
    
    if (!confirm('This will process the CSV vocabulary file. Continue?')) {
        return;
    }
    
    isProcessing = true;
    document.getElementById('process-csv-btn').disabled = true;
    document.getElementById('progress-panel').style.display = 'block';
    document.getElementById('results-panel').style.display = 'none';
    
    try {
        const response = await fetch('/dictionary/process-csv', {
            method: 'POST'
        });
        
        if (!response.ok) {
            throw new Error('Failed to start CSV processing');
        }
        
        addLog('Started processing CSV data', 'success');
        monitorProgress('csv');
        
    } catch (error) {
        addLog('Error starting CSV processing: ' + error.message, 'error');
        isProcessing = false;
        document.getElementById('process-csv-btn').disabled = false;
    }
}

// Monitor progress
async function monitorProgress(processType) {
    try {
        const response = await fetch(`/dictionary/progress/${processType}`);
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
            document.getElementById(`process-${processType}-btn`).disabled = false;
            showResults(progress.results);
            await refreshStats();
        } else {
            // Continue monitoring
            setTimeout(() => monitorProgress(processType), 2000);
        }
        
    } catch (error) {
        addLog('Error monitoring progress: ' + error.message, 'error');
        isProcessing = false;
        document.getElementById(`process-${processType}-btn`).disabled = false;
    }
}

// Show results
function showResults(results) {
    document.getElementById('results-panel').style.display = 'block';
    
    const html = `
        <div class="result-item">
            <span class="result-label">Total Records Processed:</span>
            <span class="result-value">${results.totalProcessed || 0}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Concepts Created/Updated:</span>
            <span class="result-value">${results.conceptsCreated || 0}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Terms Created/Updated:</span>
            <span class="result-value">${results.termsCreated || 0}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Examples Added:</span>
            <span class="result-value">${results.examplesCreated || 0}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Relations Created:</span>
            <span class="result-value">${results.relationsCreated || 0}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Processing Time:</span>
            <span class="result-value">${results.processingTime || 'N/A'}</span>
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

// Clear dictionary data
async function clearDictionary() {
    if (!confirm('Are you sure you want to delete ALL dictionary data? This cannot be undone!')) {
        return;
    }
    
    if (!confirm('This will delete all concepts, terms, translations, examples, and relations. Are you REALLY sure?')) {
        return;
    }
    
    try {
        const response = await fetch('/dictionary/clear-all', {
            method: 'POST'
        });
        
        if (response.ok) {
            alert('All dictionary data has been cleared.');
            addLog('All dictionary data has been cleared successfully via UI.', 'success');
            await refreshStats();
        } else {
            const errorData = await response.json();
            alert('Error clearing dictionary data: ' + (errorData.error || 'Unknown error'));
            addLog('Failed to clear dictionary data. Server responded with an error.', 'error');
        }
    } catch (error) {
        alert('Error: ' + error.message);
        addLog('A network or client-side error occurred while trying to clear the dictionary: ' + error.message, 'error');
    }
}
