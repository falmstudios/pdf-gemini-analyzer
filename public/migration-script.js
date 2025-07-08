document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-migration-btn');
    const statusText = document.getElementById('status-text');
    const detailsText = document.getElementById('details-text');
    const progressBar = document.getElementById('progress-bar');
    const logContainer = document.getElementById('log-container');
    let progressInterval;

    startBtn.addEventListener('click', startMigration);

    async function startMigration() {
        if (startBtn.disabled) return;
        if (!confirm("DANGER: This will start the data migration. It can take a very long time and should only be run once. Are you absolutely sure you want to proceed?")) {
            return;
        }

        startBtn.disabled = true;
        startBtn.textContent = 'Migrating...';

        try {
            const response = await fetch('/migration/start', { method: 'POST' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            
            progressInterval = setInterval(updateProgress, 2000);
        } catch (error) {
            alert(`Error starting migration: ${error.message}`);
            resetUI();
        }
    }

    async function updateProgress() {
        try {
            const response = await fetch('/migration/progress');
            const data = await response.json();
            
            statusText.textContent = data.status || 'N/A';
            detailsText.textContent = data.details || '';
            const percentage = Math.round((data.progress || 0) * 100);
            progressBar.style.width = `${percentage}%`;
            progressBar.textContent = `${percentage}%`;

            renderLogs(data.logs);

            if (!data.isProcessing && statusText.textContent !== 'Idle') {
                clearInterval(progressInterval);
                resetUI();
                alert(`Process finished with status: ${data.status}`);
            }
        } catch (error) {
            console.error('Failed to fetch progress:', error);
            clearInterval(progressInterval);
            resetUI();
        }
    }
    
    function renderLogs(logs) {
        if (!logs) return;
        logContainer.innerHTML = logs.map(log => 
            `<div class="log-entry ${log.type}">${new Date(log.timestamp).toLocaleTimeString()} - ${log.message}</div>`
        ).join('');
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function resetUI() {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Full Migration';
    }
    
    updateProgress();
});
