let currentPage = 1;
let currentSearchTerm = '';
let currentLetter = '';
let totalPages = 1;
let allEntries = [];

// Search functionality
async function searchDictionary() {
    const searchTerm = document.getElementById('searchInput').value.trim();
    const searchType = document.getElementById('searchType').value;
    
    if (!searchTerm) {
        loadRecentEntries();
        return;
    }
    
    currentSearchTerm = searchTerm;
    currentLetter = '';
    currentPage = 1;
    
    await loadEntries();
}

// Clear search
function clearSearch() {
    document.getElementById('searchInput').value = '';
    currentSearchTerm = '';
    currentLetter = '';
    currentPage = 1;
    loadRecentEntries();
}

// Browse by letter
async function browseByLetter(letter) {
    currentLetter = letter;
    currentSearchTerm = '';
    currentPage = 1;
    document.getElementById('searchInput').value = '';
    
    await loadEntries();
}

// Load entries
async function loadEntries() {
    const entriesDiv = document.getElementById('dictionaryEntries');
    entriesDiv.innerHTML = '<div class="loading">Loading...</div>';
    
    try {
        let url = '/dictionary/search?page=' + currentPage;
        
        if (currentSearchTerm) {
            const searchType = document.getElementById('searchType').value;
            url += '&term=' + encodeURIComponent(currentSearchTerm) + '&lang=' + searchType;
        } else if (currentLetter) {
            url += '&letter=' + currentLetter;
        }
        
        const response = await fetch(url);
        const data = await response.json();
        
        allEntries = data.entries;
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
    
    entriesDiv.innerHTML = entries.map((entry, index) => createEntryHTML(entry, index)).join('');
}

// Create HTML for a single entry
function createEntryHTML(entry, index) {
    const quickTranslation = entry.translations && entry.translations.length > 0 
        ? entry.translations[0].term 
        : '';
    
    let html = `<div class="entry" onclick="toggleEntry(${index})">`;
    
    // Header (always visible)
    html += '<div class="entry-header">';
    html += `<span class="headword">${entry.headword}`;
    if (entry.homonymNumber) {
        html += `<span class="homonym-number">${entry.homonymNumber}</span>`;
    }
    html += '</span>';
    
    if (entry.partOfSpeech) {
        html += `<span class="part-of-speech">${entry.partOfSpeech}</span>`;
    }
    
    // Show usage notes in header if present
    if (entry.notes) {
        html += `<span class="usage-note">${entry.notes}</span>`;
    }
    
    if (quickTranslation) {
        html += `<span class="quick-translation">${quickTranslation}</span>`;
        if (entry.translations[0].gender) {
            html += `<span class="gender">${entry.translations[0].gender}</span>`;
        }
    }
    
    html += '<span class="expand-icon">▼</span>';
    html += '</div>';
    
    // Details (hidden by default)
    html += '<div class="entry-details">';
    
    // All translations
    if (entry.translations && entry.translations.length > 0) {
        html += '<div class="translations-section">';
        html += '<h4>Translations:</h4>';
        entry.translations.forEach(trans => {
            html += '<div class="translation-item">';
            html += `<span class="hal-term">${trans.term}</span>`;
            
            let details = [];
            if (trans.pronunciation) details.push(`[${trans.pronunciation}]`);
            if (trans.gender) details.push(trans.gender);
            if (trans.plural) details.push(`pl. ${trans.plural}`);
            
            if (details.length > 0) {
                html += `<span class="translation-details">${details.join(', ')}</span>`;
            }
            
            // Show translation-specific note
            if (trans.note) {
                html += `<span class="translation-note"> — ${trans.note}</span>`;
            }
            
            if (trans.etymology) {
                html += `<div class="etymology">${trans.etymology}</div>`;
            }
            html += '</div>';
        });
        html += '</div>';
    }
    
    // Examples
    if (entry.examples && entry.examples.length > 0) {
        html += '<div class="examples-section">';
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
                html += `<div class="example-note">(${ex.note})</div>`;
            }
            html += '</div>';
        });
        html += '</div>';
    }
    
    // Relations
    if (entry.relations && entry.relations.length > 0) {
        html += '<div class="relations-section">';
        html += '<h4>See also:</h4>';
        entry.relations.forEach(rel => {
            html += '<div class="relation-item">';
            html += `<span class="relation-type">${formatRelationType(rel.type)}:</span> `;
            html += `<a class="relation-link" onclick="searchForTerm('${rel.targetTerm}', event)">${rel.targetTerm}</a>`;
            if (rel.note) {
                html += `<span class="relation-note"> (${rel.note})</span>`;
            }
            html += '</div>';
        });
        html += '</div>';
    }
    
    html += '</div>'; // entry-details
    html += '</div>'; // entry
    
    return html;
}
    
    html += '<span class="expand-icon">▼</span>';
    html += '</div>';
    
    // Details (hidden by default)
    html += '<div class="entry-details">';
    
    // All translations
    if (entry.translations && entry.translations.length > 0) {
        html += '<div class="translations-section">';
        html += '<h4>Translations:</h4>';
        entry.translations.forEach(trans => {
            html += '<div class="translation-item">';
            html += `<span class="hal-term">${trans.term}</span>`;
            
            let details = [];
            if (trans.pronunciation) details.push(`[${trans.pronunciation}]`);
            if (trans.gender) details.push(trans.gender);
            if (trans.plural) details.push(`pl. ${trans.plural}`);
            
            if (details.length > 0) {
                html += `<span class="translation-details">${details.join(', ')}</span>`;
            }
            
            if (trans.etymology) {
                html += `<div class="etymology">${trans.etymology}</div>`;
            }
            html += '</div>';
        });
        html += '</div>';
    }
    
    // Examples
    if (entry.examples && entry.examples.length > 0) {
        html += '<div class="examples-section">';
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
                html += `<div class="example-note">(${ex.note})</div>`;
            }
            html += '</div>';
        });
        html += '</div>';
    }
    
    // Relations
    if (entry.relations && entry.relations.length > 0) {
        html += '<div class="relations-section">';
        html += '<h4>See also:</h4>';
        entry.relations.forEach(rel => {
            html += '<div class="relation-item">';
            html += `<span class="relation-type">${formatRelationType(rel.type)}:</span> `;
            html += `<a class="relation-link" onclick="searchForTerm('${rel.targetTerm}', event)">${rel.targetTerm}</a>`;
            html += '</div>';
        });
        html += '</div>';
    }
    
    html += '</div>'; // entry-details
    html += '</div>'; // entry
    
    return html;
}

// Format relation type
function formatRelationType(type) {
    const typeMap = {
        'see_also': 'See also',
        'synonym': 'Synonym',
        'antonym': 'Antonym',
        'component_of': 'Part of',
        'etymological_origin': 'Etymology'
    };
    return typeMap[type] || type.replace(/_/g, ' ');
}

// Toggle entry expansion
function toggleEntry(index) {
    const entries = document.querySelectorAll('.entry');
    if (entries[index]) {
        entries[index].classList.toggle('expanded');
        const icon = entries[index].querySelector('.expand-icon');
        if (icon) {
            icon.textContent = entries[index].classList.contains('expanded') ? '▲' : '▼';
        }
    }
}

// Search for a specific term (from relations)
async function searchForTerm(term, event) {
    event.stopPropagation();
    document.getElementById('searchInput').value = term;
    document.getElementById('searchType').value = 'de';
    await searchDictionary();
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
