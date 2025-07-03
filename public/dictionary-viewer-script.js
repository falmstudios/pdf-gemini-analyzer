let currentPage = 1;
let currentSearchTerm = '';
let currentLetter = '';
let totalPages = 1;
let expandedEntryId = null;

// Search functionality
async function searchDictionary() {
    const searchTerm = document.getElementById('searchInput').value.trim();
    const searchLang = document.querySelector('input[name="searchLang"]:checked').value;
    
    if (!searchTerm) {
        loadRecentEntries();
        return;
    }
    
    currentSearchTerm = searchTerm;
    currentLetter = '';
    currentPage = 1;
    expandedEntryId = null;
    
    await loadEntries();
}

// Clear search
function clearSearch() {
    document.getElementById('searchInput').value = '';
    currentSearchTerm = '';
    currentLetter = '';
    currentPage = 1;
    expandedEntryId = null;
    loadRecentEntries();
}

// Browse by letter
async function browseByLetter(letter) {
    currentLetter = letter;
    currentSearchTerm = '';
    currentPage = 1;
    expandedEntryId = null;
    document.getElementById('searchInput').value = '';
    
    // Update active letter button
    document.querySelectorAll('.alphabet-nav button').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent === letter) {
            btn.classList.add('active');
        }
    });
    
    await loadEntries();
}

// Load entries
async function loadEntries() {
    const entriesDiv = document.getElementById('dictionaryEntries');
    entriesDiv.innerHTML = '<div class="loading">Loading...</div>';
    
    try {
        let url = '/dictionary/search?page=' + currentPage;
        
        if (currentSearchTerm) {
            const searchLang = document.querySelector('input[name="searchLang"]:checked').value;
            url += '&term=' + encodeURIComponent(currentSearchTerm) + '&lang=' + searchLang;
        } else if (currentLetter) {
            url += '&letter=' + currentLetter;
        }
        
        const response = await fetch(url);
        const data = await response.json();
        
        displayEntries(data.entries);
        updatePagination(data.totalPages, data.currentPage);
        updateResultsInfo(data.totalEntries);
        
    } catch (error) {
        entriesDiv.innerHTML = '<div class="no-results">Error loading entries: ' + error.message + '</div>';
    }
}

// Display entries
function displayEntries(entries) {
    const entriesDiv = document.getElementById('dictionaryEntries');
    
    if (!entries || entries.length === 0) {
        entriesDiv.innerHTML = '<div class="no-results">No entries found.</div>';
        return;
    }
    
    entriesDiv.innerHTML = entries.map(entry => createEntryHTML(entry)).join('');
}

// Create HTML for a single entry
function createEntryHTML(entry) {
    const isExpanded = expandedEntryId === entry.id;
    const translationPreview = entry.translations
        .slice(0, 3)
        .map(t => t.term)
        .join(', ') + (entry.translations.length > 3 ? '...' : '');
    
    let html = `<div class="entry ${isExpanded ? 'expanded' : ''}" onclick="toggleEntry('${entry.id}')" data-entry-id="${entry.id}">`;
    
    // Header (always visible)
    html += '<div class="entry-header">';
    html += `<span class="headword">${entry.headword}`;
    if (entry.homonymNumber) {
        html += `<sup>${entry.homonymNumber}</sup>`;
    }
    html += '</span>';
    if (entry.partOfSpeech) {
        html += `<span class="part-of-speech">${entry.partOfSpeech}</span>`;
    }
    if (entry.usageNotes) {
        html += `<span class="usage-notes">(${entry.usageNotes})</span>`;
    }
    html += '</div>';
    
    // Translation preview (only when collapsed)
    if (!isExpanded && translationPreview) {
        html += `<div class="translation-preview">${translationPreview}</div>`;
    }
    
    // Detailed content (only when expanded)
    html += '<div class="entry-details">';
    
    // Translations with all details
    if (entry.translations && entry.translations.length > 0) {
        html += '<div class="translations">';
        html += '<h4>Halunder translations:</h4>';
        entry.translations.forEach(trans => {
            html += '<div class="translation-item">';
            html += `<span class="hal-term">${trans.term}</span>`;
            if (trans.pronunciation) {
                html += `<span class="pronunciation">[${trans.pronunciation}]</span>`;
            }
            if (trans.gender) {
                html += `<span class="gender ${trans.gender}">${trans.gender}</span>`;
            }
            if (trans.plural) {
                html += `<span class="plural">pl. ${trans.plural}</span>`;
            }
            if (trans.note) {
                html += `<span class="translation-note">${trans.note}</span>`;
            }
            if (trans.etymology) {
                html += `<div class="etymology">Etymology: ${trans.etymology}</div>`;
            }
            html += '</div>';
        });
        html += '</div>';
    }
    
    // Examples
    if (entry.examples && entry.examples.length > 0) {
        html += '<div class="examples">';
        html += '<h4>Examples:</h4>';
        entry.examples.forEach(ex => {
            html += '<div class="example-item">';
            if (ex.halunder) {
                html += `<div class="example-hal">${ex.halunder}</div>`;
            }
            if (ex.german) {
                html += `<div class="example-de">"${ex.german}"</div>`;
            }
            if (ex.note) {
                html += `<div class="example-note">${ex.note}</div>`;
            }
            html += '</div>';
        });
        html += '</div>';
    }
    
    // Relations
    if (entry.relations && entry.relations.length > 0) {
        html += '<div class="relations">';
        html += '<h4>See also:</h4>';
        entry.relations.forEach(rel => {
            html += '<span class="relation-item">';
            html += `<span class="relation-type">${rel.type}:</span>`;
            if (rel.targetId) {
                html += `<a href="#" class="relation-link" onclick="searchForConcept('${rel.targetId}', '${rel.targetTerm}'); event.stopPropagation();">${rel.targetTerm}</a>`;
            } else {
                html += rel.targetTerm;
            }
            if (rel.note) {
                html += ` (${rel.note})`;
            }
            html += '</span>';
        });
        html += '</div>';
    }
    
    html += '</div>'; // entry-details
    html += '</div>'; // entry
    return html;
}

// Toggle entry expansion
function toggleEntry(entryId) {
    if (expandedEntryId === entryId) {
        expandedEntryId = null;
    } else {
        expandedEntryId = entryId;
    }
    
    // Re-render to show/hide details
    const entries = document.querySelectorAll('.entry');
    entries.forEach(entry => {
        if (entry.dataset.entryId === entryId) {
            entry.classList.toggle('expanded');
        } else {
            entry.classList.remove('expanded');
        }
    });
}

// Search for a specific concept (for relations)
async function searchForConcept(conceptId, term) {
    currentSearchTerm = term;
    currentLetter = '';
    currentPage = 1;
    expandedEntryId = conceptId;
    document.getElementById('searchInput').value = term;
    
    await searchDictionary();
    
    // Auto-expand the target entry
    setTimeout(() => {
        const targetEntry = document.querySelector(`[data-entry-id="${conceptId}"]`);
        if (targetEntry && !targetEntry.classList.contains('expanded')) {
            toggleEntry(conceptId);
        }
    }, 100);
}

// Update pagination
function updatePagination(total, current) {
    totalPages = total;
    currentPage = current;
    
    const paginationDiv = document.getElementById('pagination');
    if (total <= 1) {
        paginationDiv.innerHTML = '';
        return;
    }
    
    let html = '';
    
    // Previous button
    html += `<button onclick="goToPage(${current - 1})" ${current === 1 ? 'disabled' : ''}>Previous</button>`;
    
    // Page numbers
    let startPage = Math.max(1, current - 2);
    let endPage = Math.min(total, current + 2);
    
    if (startPage > 1) {
        html += `<button onclick="goToPage(1)">1</button>`;
        if (startPage > 2) html += `<span>...</span>`;
    }
    
    for (let i = startPage; i <= endPage; i++) {
        html += `<button onclick="goToPage(${i})" class="${i === current ? 'active' : ''}">${i}</button>`;
    }
    
    if (endPage < total) {
        if (endPage < total - 1) html += `<span>...</span>`;
        html += `<button onclick="goToPage(${total})">${total}</button>`;
    }
    
    // Next button
    html += `<button onclick="goToPage(${current + 1})" ${current === total ? 'disabled' : ''}>Next</button>`;
    
    paginationDiv.innerHTML = html;
}

// Update results info
function updateResultsInfo(total) {
    const infoDiv = document.getElementById('resultsInfo');
    if (currentSearchTerm) {
        infoDiv.textContent = `Found ${total} entries for "${currentSearchTerm}"`;
    } else if (currentLetter) {
        infoDiv.textContent = `Showing ${total} entries starting with "${currentLetter}"`;
    } else {
        infoDiv.textContent = `Showing ${total} entries`;
    }
}

// Go to page
async function goToPage(page) {
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    expandedEntryId = null;
    await loadEntries();
    window.scrollTo(0, 0);
}

// Load recent entries on page load
async function loadRecentEntries() {
    await loadEntries();
}

// Initialize
window.onload = function() {
    loadRecentEntries();
    
    // Add enter key handler for search
    document.getElementById('searchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            searchDictionary();
        }
    });
};
