let statusInterval;
let logInterval;
let lastStatusVersion = -1;
let lastLogVersion = -1;

// Load settings on page load
window.onload = async function() {
    await loadSettings();
    startPolling();
};

// Load current settings
async function loadSettings() {
    try {
        const response = await fetch('/settings');
        const settings = await response.json();
        document.getElementById('temperature').value = settings.temperature;
        document.getElementById('maxTokens').value = settings.maxOutputTokens;
        document.getElementById('prompt').value = settings.prompt;
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

// Update settings
async function updateSettings() {
    const settings = {
        temperature: parseFloat(document.getElementById('temperature').value),
        maxOutputTokens: parseInt(document.getElementById('maxTokens').value),
        prompt: document.getElementById('prompt').value
    };
    
    try {
        const response = await fetch('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        
        if (response.ok) {
            alert('Settings updated successfully!');
        }
    } catch (error) {
        alert('Error updating settings: ' + error.message);
    }
}

// Upload files
async function uploadFiles() {
    const fileInput = document.getElementById('fileInput');
    const files = fileInput.files;
    
    if (files.length === 0) {
        alert('Please select at least one PDF file');
        return;
    }
    
    const formData = new FormData();
    for (let file of files) {
        formData.append('pdfs', file);
    }
    
    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        if (result.success) {
            alert(result.message);
            fileInput.value = '';
        } else {
            alert('Error: ' + (result.error || 'Upload failed'));
        }
    } catch (error) {
        alert('Error uploading files: ' + error.message);
    }
}

// Start polling
function startPolling() {
    // Update status every 2 seconds instead of 1
    updateStatus();
    statusInterval = setInterval(updateStatus, 2000);
    
    // Update logs every 1 second instead of 500ms
    updateLogs();
    logInterval = setInterval(updateLogs, 1000);
}

// Update status display
async function updateStatus() {
    try {
        const response = await fetch('/status');
        const status = await response.json();
        
        // Only update if version changed
        if (status.version === lastStatusVersion) {
            return;
        }
        
        lastStatusVersion = status.version;
        
        // Update queue list
        updateQueueDisplay(status.queue || []);
        
    } catch (error) {
        console.error('Error updating status:', error);
    }
}

// Update queue display
function updateQueueDisplay(queue) {
    const queueList = document.getElementById('queueList');
    
    if (!queue || queue.length === 0) {
        queueList.innerHTML = '<p>No files in queue</p>';
        return;
    }
    
    // Build new HTML
    let newHTML = '';
    queue.forEach(item => {
        let statusBadge = '';
        let actionButton = '';
        
        switch(item.status) {
            case 'queued':
                statusBadge = '<span class="status-badge queued">Queued</span>';
                break;
            case 'processing':
                statusBadge = '<span class="status-badge processing">Processing...</span>';
                break;
            case 'completed':
                statusBadge = '<span class="status-badge completed">Completed</span>';
                actionButton = `<button class="download-btn" onclick="downloadResult('${item.id}')">Download Result</button>`;
                break;
            case 'error':
                statusBadge = `<span class="status-badge error">Error: ${item.error || 'Unknown error'}</span>`;
                break;
        }
        
        newHTML += `
            <div class="queue-item ${item.status}">
                <div class="queue-item-info">
                    <strong>${item.filename}</strong>
                    ${statusBadge}
                </div>
                <div class="queue-item-actions">
                    ${actionButton}
                </div>
            </div>
        `;
    });
    
    queueList.innerHTML = newHTML;
}

// Update logs display
async function updateLogs() {
    try {
        const response = await fetch('/logs');
        const data = await response.json();
        
        // Only update if version changed
        if (data.version === lastLogVersion) {
            return;
        }
        
        lastLogVersion = data.version;
        
        const consoleDiv = document.getElementById('console');
        const wasAtBottom = Math.abs(consoleDiv.scrollHeight - consoleDiv.scrollTop - consoleDiv.clientHeight) < 5;
        
        consoleDiv.innerHTML = '';
        
        if (!data.logs || data.logs.length === 0) {
            consoleDiv.innerHTML = '<p class="console-empty">No logs available</p>';
            return;
        }
        
        data.logs.forEach(log => {
            const logEntry = document.createElement('div');
            logEntry.className = `console-entry ${log.type}`;
            
            const timestamp = new Date(log.timestamp).toLocaleTimeString();
            const filename = log.filename ? `[${log.filename}] ` : '';
            logEntry.innerHTML = `<span class="timestamp">[${timestamp}]</span> ${filename}${log.message}`;
            
            consoleDiv.appendChild(logEntry);
        });
        
        // Auto-scroll to bottom only if user was at bottom
        if (wasAtBottom) {
            consoleDiv.scrollTop = consoleDiv.scrollHeight;
        }
        
    } catch (error) {
        console.error('Error fetching logs:', error);
    }
}

// Download result
async function downloadResult(id) {
    try {
        window.location.href = `/download/${id}`;
    } catch (error) {
        alert('Error downloading result: ' + error.message);
    }
}

// Clear completed items
async function clearCompleted() {
    try {
        const response = await fetch('/clear-completed', {
            method: 'POST'
        });
        
        const result = await response.json();
        if (result.success) {
            alert(`Cleared ${result.cleared} completed items`);
        }
    } catch (error) {
        alert('Error clearing completed items: ' + error.message);
    }
}

// Clear logs
async function clearLogs() {
    try {
        const response = await fetch('/clear-logs', {
            method: 'POST'
        });
        
        if (response.ok) {
            lastLogVersion = -1;
            document.getElementById('console').innerHTML = '<p class="console-empty">Logs cleared</p>';
        }
    } catch (error) {
        alert('Error clearing logs: ' + error.message);
    }
}

// Clean up intervals when page unloads
window.onbeforeunload = function() {
    if (statusInterval) {
        clearInterval(statusInterval);
    }
    if (logInterval) {
        clearInterval(logInterval);
    }
};
