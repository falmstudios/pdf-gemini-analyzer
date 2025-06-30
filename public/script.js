let currentLogs = new Map(); // Track logs by ID to avoid duplicates
let statusCheckCount = 0;

// Load settings on page load
window.onload = async function() {
    await loadSettings();
    // Initial update
    updateStatus();
    // Update every 3 seconds
    setInterval(updateStatus, 3000);
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

// Update status display
async function updateStatus() {
    try {
        statusCheckCount++;
        const response = await fetch('/status');
        const status = await response.json();
        
        // Update queue display
        updateQueueDisplay(status.queue || []);
        
        // Update logs display
        updateLogsDisplay(status.logs || []);
        
    } catch (error) {
        console.error('Error updating status:', error);
    }
}

// Update queue display - only update if content changed
let lastQueueHTML = '';
function updateQueueDisplay(queue) {
    const queueList = document.getElementById('queueList');
    
    let html = '';
    if (!queue || queue.length === 0) {
        html = '<p>No files in queue</p>';
    } else {
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
            
            html += `
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
    }
    
    // Only update DOM if content changed
    if (html !== lastQueueHTML) {
        queueList.innerHTML = html;
        lastQueueHTML = html;
    }
}

// Update logs display - only add new logs
function updateLogsDisplay(logs) {
    const consoleDiv = document.getElementById('console');
    
    // If no logs yet, show empty message
    if (logs.length === 0 && currentLogs.size === 0) {
        if (!consoleDiv.querySelector('.console-empty')) {
            consoleDiv.innerHTML = '<p class="console-empty">No logs available</p>';
        }
        return;
    }
    
    // Remove empty message if it exists
    const emptyMsg = consoleDiv.querySelector('.console-empty');
    if (emptyMsg && logs.length > 0) {
        emptyMsg.remove();
    }
    
    // Check if we need to scroll
    const wasAtBottom = Math.abs(consoleDiv.scrollHeight - consoleDiv.scrollTop - consoleDiv.clientHeight) < 50;
    
    // Add only new logs
    logs.forEach(log => {
        if (!currentLogs.has(log.id)) {
            currentLogs.set(log.id, true);
            
            const logEntry = document.createElement('div');
            logEntry.className = `console-entry ${log.type}`;
            
            const timestamp = new Date(log.timestamp).toLocaleTimeString();
            const filename = log.filename ? `[${log.filename}] ` : '';
            logEntry.innerHTML = `<span class="timestamp">[${timestamp}]</span> ${filename}${log.message}`;
            
            consoleDiv.appendChild(logEntry);
        }
    });
    
    // Auto-scroll if user was at bottom
    if (wasAtBottom) {
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
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
            currentLogs.clear();
            document.getElementById('console').innerHTML = '<p class="console-empty">Logs cleared</p>';
        }
    } catch (error) {
        alert('Error clearing logs: ' + error.message);
    }
}
