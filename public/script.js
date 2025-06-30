let statusInterval;

// Load settings on page load
window.onload = async function() {
    await loadSettings();
    startStatusPolling();
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

// Start polling for status updates
function startStatusPolling() {
    // Update immediately
    updateStatus();
    // Then update every second
    statusInterval = setInterval(updateStatus, 1000);
}

// Update status display
async function updateStatus() {
    try {
        const response = await fetch('/status');
        const status = await response.json();
        
        // Update total progress
        const totalProgress = status.totalProgress || 0;
        document.getElementById('totalProgress').style.width = totalProgress + '%';
        document.getElementById('totalProgressText').textContent = totalProgress + '%';
        
        // Update current file progress
        if (status.currentlyProcessing) {
            document.getElementById('currentFile').style.display = 'block';
            document.getElementById('currentFileName').textContent = status.currentlyProcessing.filename;
            document.getElementById('currentProgress').style.width = status.currentlyProcessing.progress + '%';
            document.getElementById('currentProgressText').textContent = status.currentlyProcessing.progress + '%';
            
            // Show sub-status if available
            const statusText = document.getElementById('currentStatus');
            if (status.currentlyProcessing.subStatus) {
                statusText.textContent = `Status: ${status.currentlyProcessing.subStatus}`;
            }
        } else {
            document.getElementById('currentFile').style.display = 'none';
        }
        
        // Update queue list
        updateQueueDisplay(status.queue);
        
    } catch (error) {
        console.error('Error updating status:', error);
    }
}

// Update queue display
function updateQueueDisplay(queue) {
    const queueList = document.getElementById('queueList');
    queueList.innerHTML = '';
    
    if (!queue || queue.length === 0) {
        queueList.innerHTML = '<p>No files in queue</p>';
        return;
    }
    
    queue.forEach(item => {
        const div = document.createElement('div');
        div.className = `queue-item ${item.status}`;
        
        let statusBadge = '';
        let actionButton = '';
        
        switch(item.status) {
            case 'queued':
                statusBadge = '<span class="status-badge">Queued</span>';
                break;
            case 'processing':
                statusBadge = `<span class="status-badge">Processing... ${item.progress}%</span>`;
                break;
            case 'completed':
                statusBadge = '<span class="status-badge">Completed</span>';
                actionButton = `<button class="download-btn" onclick="downloadResult('${item.id}')">Download Result</button>`;
                break;
            case 'error':
                statusBadge = `<span class="status-badge error">Error: ${item.error || 'Unknown error'}</span>`;
                break;
        }
        
        div.innerHTML = `
            <div>
                <strong>${item.filename}</strong>
                ${statusBadge}
            </div>
            ${actionButton}
        `;
        
        queueList.appendChild(div);
    });
}

// Download result
async function downloadResult(id) {
    try {
        const response = await fetch(`/download/${id}`);
        
        if (!response.ok) {
            throw new Error('Download failed');
        }
        
        const data = await response.json();
        
        // Create a blob and download
        const blob = new Blob([data.result], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${data.filename}_analysis.json`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
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

// Clean up interval when page unloads
window.onbeforeunload = function() {
    if (statusInterval) {
        clearInterval(statusInterval);
    }
};
